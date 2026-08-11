import { applyTradingSettings, loadConfig, validateTradingSettings } from "./application/config/AppConfig.js";
import { MarketScanner } from "./application/scanner/MarketScanner.js";
import { BinanceFuturesAccountClient } from "./infrastructure/execution/BinanceFuturesAccountClient.js";
import { createExecutionGateway } from "./infrastructure/execution/createExecutionGateway.js";
import { ConsoleDecisionLogger } from "./infrastructure/logging/ConsoleDecisionLogger.js";
import { BinanceFuturesMarketData } from "./infrastructure/market-data/BinanceFuturesMarketData.js";
import { createRepository } from "./infrastructure/persistence/PostgresTradingRepository.js";
import { startHttpServer } from "./presentation/http/Server.js";

let config = loadConfig();
const logger = new ConsoleDecisionLogger();
const repository = await createRepository(config.databaseUrl);
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
const scanner = new MarketScanner(config, repository, execution, logger, marketData, availableBalanceProvider);
const engine = scanner.getPrimaryEngine();

startHttpServer({ port: config.port, config, engine, repository, logger, scanner });

async function bootstrap(): Promise<void> {
  await scanner.bootstrap();
  scanner.start();
}

bootstrap().catch((error: unknown) => {
  logger.error("Bootstrap failed", { error: error instanceof Error ? error.message : String(error) });
});
