import type { AppConfig } from "../../application/config/AppConfig.js";
import type { ExecutionGateway } from "../../application/ports/ExecutionGateway.js";
import { BinanceFuturesExecutionGateway } from "./BinanceFuturesExecutionGateway.js";

export function createExecutionGateway(config: AppConfig): ExecutionGateway {
  if (!config.binanceApiKey || !config.binanceApiSecret) {
    throw new Error(`${config.executionMode} mode requires BINANCE_API_KEY and BINANCE_API_SECRET`);
  }

  return new BinanceFuturesExecutionGateway(config.binanceApiKey, config.binanceApiSecret, config.executionMode, config.symbol, config.entryMode, config.leverage);
}
