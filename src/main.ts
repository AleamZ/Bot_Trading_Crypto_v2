import { loadConfig } from "./application/config/AppConfig.js";
import { TradingEngine } from "./application/engine/TradingEngine.js";
import { BinanceFuturesAccountClient } from "./infrastructure/execution/BinanceFuturesAccountClient.js";
import { createExecutionGateway } from "./infrastructure/execution/createExecutionGateway.js";
import { ConsoleDecisionLogger } from "./infrastructure/logging/ConsoleDecisionLogger.js";
import { BinanceFuturesMarketData } from "./infrastructure/market-data/BinanceFuturesMarketData.js";
import { createRepository } from "./infrastructure/persistence/PostgresTradingRepository.js";
import { startHttpServer } from "./presentation/http/Server.js";

const config = loadConfig();
const logger = new ConsoleDecisionLogger();
const repository = await createRepository(config.databaseUrl);
const execution = createExecutionGateway(config);
const accountClient =
  config.binanceApiKey && config.binanceApiSecret
    ? new BinanceFuturesAccountClient(config.binanceApiKey, config.binanceApiSecret, config.binanceTestnet)
    : null;
const engine = new TradingEngine(config, repository, execution, logger, async () => {
  const status = await accountClient?.getWalletStatus();
  return status?.connected ? status.availableBalance : null;
});
const marketData = new BinanceFuturesMarketData(config.binanceTestnet);

startHttpServer({ port: config.port, config, engine, repository, logger });

async function bootstrap(): Promise<void> {
  const [h1, m5] = await Promise.all([
    marketData.getClosedCandles(config.symbol, "H1", Math.max(config.emaPeriod + 10, 80)),
    marketData.getClosedCandles(config.symbol, "M5", 300)
  ]);

  const candles = [...h1, ...m5].sort((a, b) => a.closeTime - b.closeTime);
  for (const candle of candles) {
    await engine.onClosedCandle(candle);
  }
}

bootstrap().catch((error: unknown) => {
  logger.error("Bootstrap failed", { error: error instanceof Error ? error.message : String(error) });
});
