import type { TradingSettings } from "../config/AppConfig.js";
import type { ExecutionIntent } from "../execution/ExecutionIntent.js";
import type { BinanceFuturesTradeHistoryStatus } from "../../infrastructure/execution/BinanceFuturesAccountClient.js";

export interface DailyRiskStatus {
  tradingAccountId: string;
  tradingDay: string;
  timezone: "UTC";
  realizedPnlUsdt: number;
  realizedR: number;
  dailyProfitLimitR: number;
  dailyLossLimitR: number;
  newEntriesAllowed: boolean;
  blockReason: DailyRiskBlockReason | null;
}

export type DailyRiskBlockReason = "DAILY_PROFIT_LIMIT_REACHED" | "DAILY_LOSS_LIMIT_REACHED";

export function calculateDailyRiskStatus(input: {
  tradingAccountId: string;
  settings: Pick<TradingSettings, "dailyProfitLimitR" | "dailyLossLimitR">;
  intents: readonly ExecutionIntent[];
  trades: readonly BinanceFuturesTradeHistoryStatus[];
  now?: Date;
}): DailyRiskStatus {
  const now = input.now ?? new Date();
  const tradingDay = utcTradingDay(now);
  const dayStartSeconds = Math.floor(Date.parse(`${tradingDay}T00:00:00.000Z`) / 1000);
  const dayEndSeconds = dayStartSeconds + 24 * 60 * 60;
  const intentsByOrderId = new Map<string, ExecutionIntent>();
  for (const intent of input.intents) {
    if (intent.tradingAccountId !== input.tradingAccountId) continue;
    for (const orderId of [intent.binanceEntryOrderId, intent.binanceStopOrderId, intent.binanceTakeProfitOrderId]) {
      if (orderId) intentsByOrderId.set(orderId, intent);
    }
  }

  let realizedPnlUsdt = 0;
  let realizedR = 0;
  const seenTradeIds = new Set<string>();
  for (const trade of input.trades) {
    if (seenTradeIds.has(trade.id)) continue;
    seenTradeIds.add(trade.id);
    const closedAt = trade.createdAt;
    if (closedAt === null || closedAt < dayStartSeconds || closedAt >= dayEndSeconds) continue;
    if (trade.tradingAccountId && trade.tradingAccountId !== input.tradingAccountId) continue;
    const intent = intentsByOrderId.get(trade.orderId);
    if (!intent || intent.source !== "BOT") continue;
    const riskBasis = intentRiskBasisUsdt(intent);
    if (riskBasis <= 0) continue;
    realizedPnlUsdt += trade.realizedPnl;
    realizedR += trade.realizedPnl / riskBasis;
  }

  const blockReason =
    realizedR >= input.settings.dailyProfitLimitR
      ? "DAILY_PROFIT_LIMIT_REACHED"
      : realizedR <= -input.settings.dailyLossLimitR
        ? "DAILY_LOSS_LIMIT_REACHED"
        : null;

  return {
    tradingAccountId: input.tradingAccountId,
    tradingDay,
    timezone: "UTC",
    realizedPnlUsdt,
    realizedR,
    dailyProfitLimitR: input.settings.dailyProfitLimitR,
    dailyLossLimitR: input.settings.dailyLossLimitR,
    newEntriesAllowed: blockReason === null,
    blockReason
  };
}

export function utcTradingDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function intentRiskBasisUsdt(intent: ExecutionIntent): number {
  if (intent.requestedEntry === null || intent.requestedStopLoss === null || intent.quantity === null) return 0;
  return Math.abs(intent.requestedEntry - intent.requestedStopLoss) * intent.quantity;
}
