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
import { startHttpServer } from "./presentation/http/Server.js";

let config = loadConfig();
if (process.env.NODE_ENV === "production") {
  if (!config.sessionSecret) throw new Error("SESSION_SECRET must be configured in production");
  if (!config.binanceCredentialEncryptionKey) throw new Error("BINANCE_CREDENTIAL_ENCRYPTION_KEY must be configured in production");
}
const logger = new ConsoleDecisionLogger();
const repository = await createRepository(config.databaseUrl);
const authRepository = await createAuthRepository(config.databaseUrl);
const auth = new AuthService(authRepository, config.sessionSecret ?? "development-session-secret-change-before-production");
const tradingAccountRepository = await createTradingAccountRepository(config.databaseUrl);
const tradingRuntimeConfigRepository = await createTradingRuntimeConfigRepository(config.databaseUrl);
const executionIntentRepository = await createExecutionIntentRepository(config.databaseUrl);
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
const runtimeManager = new TradingRuntimeManager(config, config.databaseUrl, tradingAccountRepository, tradingRuntimeConfigRepository, executionIntentRepository, credentialCipher, marketData, logger);
const scanner = new MarketScanner(config, repository, execution, logger, marketData, availableBalanceProvider);
const engine = scanner.getPrimaryEngine();

startHttpServer({ port: config.port, config, engine, repository, logger, scanner, auth, tradingAccounts, runtimeManager });

async function bootstrap(): Promise<void> {
  logger.warn("Legacy global scanner is disabled; authenticated UI uses account-scoped TradingRuntimeManager");
  await runtimeManager.start();
}

bootstrap().catch((error: unknown) => {
  logger.error("Bootstrap failed", { error: error instanceof Error ? error.message : String(error) });
});
