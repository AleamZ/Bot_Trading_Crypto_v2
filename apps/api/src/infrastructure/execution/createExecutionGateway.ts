import type { AppConfig } from "../../application/config/AppConfig.js";
import type { ExecutionGateway } from "../../application/ports/ExecutionGateway.js";
import { BinanceFuturesExecutionGateway } from "./BinanceFuturesExecutionGateway.js";
import { LockedRealExecutionGateway } from "./LockedRealExecutionGateway.js";
import { PaperExecutionGateway } from "./PaperExecutionGateway.js";

export function createExecutionGateway(config: AppConfig): ExecutionGateway {
  if (config.executionMode === "paper") {
    return new PaperExecutionGateway();
  }

  if (!config.binanceApiKey || !config.binanceApiSecret) {
    throw new Error(`${config.executionMode} mode requires BINANCE_API_KEY and BINANCE_API_SECRET`);
  }

  if (config.executionMode === "live" && !config.realLiveExecutionEnabled) {
    return new LockedRealExecutionGateway();
  }

  return new BinanceFuturesExecutionGateway(config.binanceApiKey, config.binanceApiSecret, config.executionMode, config.entryMode, config.maxLeverage);
}
