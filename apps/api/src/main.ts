import { applyTradingSettings, loadConfig, validateTradingSettings } from "./application/config/AppConfig.js";
import { MarketScanner } from "./application/scanner/MarketScanner.js";
import { AuthService } from "./application/auth/AuthService.js";
import { TradingAccountService } from "./application/trading-account/TradingAccountService.js";
import { TradingRuntimeManager } from "./application/runtime/TradingRuntimeManager.js";
import { BinanceFuturesAccountClient } from "./infrastructure/execution/BinanceFuturesAccountClient.js";
import { createExecutionGateway } from "./infrastructure/execution/createExecutionGateway.js";
import { ConsoleDecisionLogger } from "./infrastructure/logging/ConsoleDecisionLogger.js";
import { BinanceFuturesMarketData } from "./infrastructure/market-data/BinanceFuturesMarketData.js";
import { createAuthRepository } from "./infrastructure/auth/PostgresAuthRepository.js";
import { createRepository } from "./infrastructure/persistence/PostgresTradingRepository.js";
import { CredentialCipher } from "./infrastructure/security/CredentialCipher.js";
import { BinanceFuturesAccountVerifier } from "./infrastructure/trading-account/BinanceFuturesAccountVerifier.js";
import { createTradingAccountRepository } from "./infrastructure/trading-account/PostgresTradingAccountRepository.js";
import { createTradingRuntimeConfigRepository } from "./infrastructure/trading-account/PostgresTradingRuntimeConfigRepository.js";
import { createExecutionIntentRepository } from "./infrastructure/execution/PostgresExecutionIntentRepository.js";
import { createRealExecutionProposalRepository } from "./infrastructure/execution/PostgresRealExecutionProposalRepository.js";
import { closeAllPostgresPools, verifyPostgresConnection } from "./infrastructure/persistence/PgPoolFactory.js";
import { startHttpServer } from "./presentation/http/Server.js";

let config = loadConfig();
const logger = new ConsoleDecisionLogger();
logger.info("Production configuration state", {
  nodeEnv: config.nodeEnv,
  databaseUrl: config.databaseUrl ? "configured" : "not_configured",
  sessionSecret: config.sessionSecret ? "configured" : "not_configured",
  binanceCredentialEncryptionKey: config.binanceCredentialEncryptionKey ? "configured" : "not_configured",
  corsOrigins: config.corsOrigins,
  postgresPoolMax: config.postgresPoolMax
});
const repository = await createRepository(config.databaseUrl);
const authRepository = await createAuthRepository(config.databaseUrl);
const auth = new AuthService(authRepository, config.sessionSecret ?? "development-session-secret-change-before-production");
const tradingAccountRepository = await createTradingAccountRepository(config.databaseUrl);
const tradingRuntimeConfigRepository = await createTradingRuntimeConfigRepository(config.databaseUrl);
const executionIntentRepository = await createExecutionIntentRepository(config.databaseUrl);
const realExecutionProposalRepository = await createRealExecutionProposalRepository(config.databaseUrl);
const credentialCipher = new CredentialCipher(config.binanceCredentialEncryptionKey ?? "0000000000000000000000000000000000000000000000000000000000000000");
const tradingAccounts = new TradingAccountService(
  tradingAccountRepository,
  credentialCipher,
  new BinanceFuturesAccountVerifier(),
  tradingRuntimeConfigRepository,
  validateTradingSettings(config)
);
const storedSettings = await repository.getTradingSettings();
if (storedSettings) {
  config = applyTradingSettings(config, validateTradingSettings(storedSettings));
} else {
  await repository.saveTradingSettings(validateTradingSettings(config));
}
const execution = createExecutionGateway(config);
const accountClient =
  config.binanceApiKey && config.binanceApiSecret
    ? new BinanceFuturesAccountClient(config.binanceApiKey, config.binanceApiSecret, config.binanceTestnet)
    : null;
const availableBalanceProvider = async () => {
  const status = await accountClient?.getWalletStatus();
  return status?.connected ? status.availableBalance : null;
};
const marketData = new BinanceFuturesMarketData(config.binanceTestnet);
const runtimeManager = new TradingRuntimeManager(
  config,
  config.databaseUrl,
  tradingAccountRepository,
  tradingRuntimeConfigRepository,
  executionIntentRepository,
  credentialCipher,
  marketData,
  logger,
  undefined,
  undefined,
  realExecutionProposalRepository
);
const scanner = new MarketScanner(config, repository, execution, logger, marketData, availableBalanceProvider);
const engine = scanner.getPrimaryEngine();
const appState = { shuttingDown: false, bootstrapComplete: false, startedAt: Date.now() };
const buildInfo = {
  version: process.env.APP_VERSION ?? "0.1.0",
  gitSha: process.env.GIT_SHA ?? null,
  buildTime: process.env.BUILD_TIME ?? null
};

const server = startHttpServer({
  port: config.port,
  config,
  engine,
  repository,
  logger,
  scanner,
  auth,
  tradingAccounts,
  runtimeManager,
  appState,
  buildInfo,
  readinessCheck: async () => {
    if (!config.databaseUrl) return true;
    await verifyPostgresConnection(config.databaseUrl);
    return true;
  }
});

async function bootstrap(): Promise<void> {
  logger.warn("Legacy global scanner is disabled; authenticated UI uses account-scoped TradingRuntimeManager");
  const localRuntimeAllowed = config.nodeEnv !== "development" || config.localTradingRuntimeEnabled;
  if (localRuntimeAllowed) {
    await runtimeManager.start();
  } else {
    logger.warn("Development trading runtimes disabled; set LOCAL_TRADING_RUNTIME_ENABLED=true to opt in");
  }
  appState.bootstrapComplete = true;
  logger.info("Runtime bootstrap complete", runtimeManager.getOperationalStatus());
}

bootstrap().catch((error: unknown) => {
  appState.bootstrapComplete = false;
  logger.error("Bootstrap failed", { error: error instanceof Error ? error.message : String(error) });
});

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (appState.shuttingDown) return;
  appState.shuttingDown = true;
  logger.warn("Graceful shutdown started", { reason });
  await runtimeManager.shutdown();
  scanner.stop();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await closeAllPostgresPools();
  logger.warn("Graceful shutdown complete", { reason });
  process.exit(exitCode);
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM", 0).catch((error: unknown) => {
    logger.error("Graceful shutdown failed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
});

process.on("SIGINT", () => {
  shutdown("SIGINT", 0).catch((error: unknown) => {
    logger.error("Graceful shutdown failed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
});

process.on("unhandledRejection", (error) => {
  logger.error("Unhandled promise rejection", { error: error instanceof Error ? error.message : String(error) });
  shutdown("unhandledRejection", 1).catch(() => process.exit(1));
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error: error.message });
  shutdown("uncaughtException", 1).catch(() => process.exit(1));
});
