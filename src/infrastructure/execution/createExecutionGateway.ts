import type { AppConfig } from "../../application/config/AppConfig.js";
import type { ExecutionGateway } from "../../application/ports/ExecutionGateway.js";
import { BinanceFuturesExecutionGateway } from "./BinanceFuturesExecutionGateway.js";
import { PaperExecutionGateway } from "./PaperExecutionGateway.js";

export function createExecutionGateway(config: AppConfig): ExecutionGateway {
  if (config.executionMode === "paper") {
    return new PaperExecutionGateway();
  }

  if (!config.binanceApiKey || !config.binanceApiSecret) {
    throw new Error(`${config.executionMode} mode requires BINANCE_API_KEY and BINANCE_API_SECRET`);
  }

  return new BinanceFuturesExecutionGateway(config.binanceApiKey, config.binanceApiSecret, config.executionMode, config.entryMode, config.leverage);
}
