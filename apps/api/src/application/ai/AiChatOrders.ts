import crypto from "node:crypto";
import type { AppConfig } from "../config/AppConfig.js";
import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";
import { evaluateRisk } from "../../domain/risk/RiskManager.js";
import type { FuturesSymbolRules } from "../../domain/symbol/SymbolRules.js";

/** A proposal card stays valid this long; the price is re-checked when the user confirms anyway. */
export const CHAT_ORDER_TTL_MS = 2 * 60_000;
const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}USDT$/;

/** What the chat model asks for. Entries are MARKET; quantity is in base-asset units. */
export interface ChatOrderRequest {
  symbol: string;
  side: "LONG" | "SHORT";
  stopLoss: number;
  takeProfit: number;
  /** Coins to buy/sell; null = size from the account's riskPerTradeUsdt. */
  quantity: number | null;
  reason: string;
}

/** Account state the risk manager needs, read fresh for every proposal and confirmation. */
export interface ChatOrderMarket {
  mode: "DEMO" | "REAL";
  /** Execution gate reason when orders cannot be placed right now (automatic trading switch excluded). */
  executionBlocked?: string | null;
  config: AppConfig;
  livePrice: number | null;
  availableBalance: number;
  currentUsedMargin: number;
  openPositions: number;
  symbolOpenPositions: number;
  symbolRules: FuturesSymbolRules;
  drawdownPercent: number;
}

export interface ChatOrderProposal {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  /** Live price when proposed; the order fills at the price when confirmed. */
  entry: number;
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  /** USER = the quantity the user asked for; RISK = sized from riskPerTradeUsdt. */
  sizing: "USER" | "RISK";
  notional: number;
  margin: number;
  leverage: number;
  riskUsdt: number;
  profitUsdt: number;
  riskReward: number;
  reason: string;
  createdAt: string;
  expiresAt: string;
}

export type ChatOrderProposalResult = { ok: true; proposal: ChatOrderProposal } | { ok: false; code: string; reason: string };

export interface ChatOrderConfirmation {
  status: "SUBMITTED";
  proposalId: string;
  executionIntentId: string | null;
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

/** Why the execution gate refuses orders, worded for the chat model and the card. */
const EXECUTION_BLOCKED_REASONS: Record<string, string> = {
  READ_ONLY_SOAK_EXECUTION_BLOCKED: "The account is in read-only soak mode, which blocks every order: turn off readOnlySoak for this account and READ_ONLY_SOAK in the server .env",
  KILL_SWITCH: "The kill switch is on: turn it off in Settings to place orders",
  RUNTIME_NOT_READY: "The trading runtime is still starting or recovering; try again in a moment",
  BINANCE_DISCONNECTED: "Binance is not connected for this account",
  RECONCILIATION_REQUIRED: "Positions and orders must be reconciled with Binance first; try again in a moment",
  SHUTTING_DOWN: "The server is restarting; try again in a moment"
};

export class ChatOrderError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ChatOrderError";
  }
}

export interface ChatOrderDeskOptions {
  loadMarket(accountId: string, symbol: string): Promise<ChatOrderMarket>;
  /** Places the MARKET entry with SL/TP; throws with Binance's own error on failure. */
  submit(accountId: string, plan: EntryPlan, risk: RiskDecision): Promise<{ executionIntentId: string | null }>;
  now?: () => number;
  ttlMs?: number;
}

interface StoredProposal {
  accountId: string;
  userId: string;
  proposal: ChatOrderProposal;
  used: boolean;
}

/**
 * Orders the chat proposes and the user confirms. Proposing never trades: it runs the risk manager
 * and keeps a short-lived card; only confirm() places the order, after checking it again at the
 * live price. The automatic-trading switch is ignored (the user asked), the kill switch is not.
 */
export class AiChatOrderDesk {
  private readonly proposals = new Map<string, StoredProposal>();
  private readonly now: () => number;

  constructor(private readonly options: ChatOrderDeskOptions) {
    this.now = options.now ?? Date.now;
  }

  async propose(accountId: string, userId: string, request: ChatOrderRequest): Promise<ChatOrderProposalResult> {
    this.dropExpired();
    const symbol = normalizeSymbol(request.symbol);
    if (!symbol) return { ok: false, code: "INVALID_SYMBOL", reason: `${request.symbol} is not a USDT-M symbol (e.g. BTCUSDT)` };
    if (request.quantity !== null && !(Number.isFinite(request.quantity) && request.quantity > 0)) {
      return { ok: false, code: "INVALID_QUANTITY", reason: "quantity must be a positive number of coins, or null to size from risk" };
    }
    let market: ChatOrderMarket;
    try {
      market = await this.options.loadMarket(accountId, symbol);
    } catch (error) {
      return { ok: false, code: "MARKET_UNAVAILABLE", reason: error instanceof Error ? error.message : String(error) };
    }
    const assessed = assessChatOrder({ ...request, symbol }, market, this.now());
    if (!assessed.ok) return assessed;

    const createdAt = this.now();
    const proposal: ChatOrderProposal = {
      id: crypto.randomUUID(),
      symbol,
      side: request.side,
      entry: assessed.plan.entry,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      quantity: assessed.risk.quantity,
      sizing: request.quantity === null ? "RISK" : "USER",
      notional: assessed.risk.notional,
      margin: assessed.risk.requiredMargin,
      leverage: assessed.risk.selectedLeverage,
      riskUsdt: assessed.risk.actualRiskUsdt,
      profitUsdt: assessed.risk.estimatedProfit,
      riskReward: assessed.risk.riskReward,
      reason: request.reason.trim().slice(0, 500),
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + (this.options.ttlMs ?? CHAT_ORDER_TTL_MS)).toISOString()
    };
    this.proposals.set(proposal.id, { accountId, userId, proposal, used: false });
    return { ok: true, proposal };
  }

  async confirm(accountId: string, userId: string, proposalId: string): Promise<ChatOrderConfirmation> {
    const stored = this.proposals.get(proposalId);
    if (!stored || stored.accountId !== accountId || stored.userId !== userId) throw new ChatOrderError("CHAT_ORDER_NOT_FOUND", "This order proposal does not exist (it may have expired after a restart)");
    if (stored.used) throw new ChatOrderError("CHAT_ORDER_ALREADY_USED", "This order proposal was already confirmed");
    if (Date.parse(stored.proposal.expiresAt) <= this.now()) {
      this.proposals.delete(proposalId);
      throw new ChatOrderError("CHAT_ORDER_EXPIRED", "This order proposal expired; ask the AI for a new one");
    }
    // One click places one order, even if the submit below fails or the user clicks twice.
    stored.used = true;
    const { proposal } = stored;
    const market = await this.options.loadMarket(accountId, proposal.symbol);
    // The size the user saw on the card, re-checked against the live price and current account state.
    const assessed = assessChatOrder(
      { symbol: proposal.symbol, side: proposal.side, stopLoss: proposal.stopLoss, takeProfit: proposal.takeProfit, quantity: proposal.quantity, reason: proposal.reason },
      market,
      this.now()
    );
    if (!assessed.ok) throw new ChatOrderError(assessed.code, assessed.reason);
    const submitted = await this.options.submit(accountId, assessed.plan, assessed.risk);
    return {
      status: "SUBMITTED",
      proposalId,
      executionIntentId: submitted.executionIntentId,
      symbol: proposal.symbol,
      side: proposal.side,
      quantity: assessed.risk.quantity,
      entry: assessed.plan.entry,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit
    };
  }

  private dropExpired(): void {
    const now = this.now();
    for (const [id, stored] of this.proposals) {
      if (Date.parse(stored.proposal.expiresAt) <= now) this.proposals.delete(id);
    }
  }
}

/** Checks a chat order at the live price and sizes it through the bot's risk manager. */
export function assessChatOrder(
  request: ChatOrderRequest,
  market: ChatOrderMarket,
  at: number
): { ok: true; plan: EntryPlan; risk: RiskDecision } | { ok: false; code: string; reason: string } {
  if (market.mode !== "DEMO") return { ok: false, code: "REAL_EXECUTION_LOCKED", reason: "Chat orders are DEMO-only; REAL accounts stay locked" };
  if (market.executionBlocked) return { ok: false, code: market.executionBlocked, reason: EXECUTION_BLOCKED_REASONS[market.executionBlocked] ?? `Order execution is blocked (${market.executionBlocked})` };
  const price = market.livePrice;
  if (price === null || !Number.isFinite(price) || price <= 0) return { ok: false, code: "LIVE_PRICE_UNAVAILABLE", reason: `No live price for ${request.symbol}` };
  if (![request.stopLoss, request.takeProfit].every((value) => Number.isFinite(value) && value > 0)) {
    return { ok: false, code: "INVALID_PRICE", reason: "stopLoss and takeProfit must be positive prices" };
  }
  const long = request.side === "LONG";
  const inside = long ? request.stopLoss < price && price < request.takeProfit : request.takeProfit < price && price < request.stopLoss;
  if (!inside) {
    return {
      ok: false,
      code: "PRICE_OUTSIDE_SL_TP",
      reason: long
        ? `A LONG needs stopLoss < price < takeProfit; price is ${price}, SL ${request.stopLoss}, TP ${request.takeProfit}`
        : `A SHORT needs takeProfit < price < stopLoss; price is ${price}, SL ${request.stopLoss}, TP ${request.takeProfit}`
    };
  }
  const stopDistance = Math.abs(price - request.stopLoss);
  const { config } = market;
  const risk = evaluateRisk({
    symbol: request.symbol,
    direction: long ? "bullish" : "bearish",
    availableBalance: market.availableBalance,
    symbolRules: market.symbolRules,
    // A user-given quantity becomes the risk that sizes exactly that many coins.
    riskPerTradeUsdt: request.quantity === null ? config.riskPerTradeUsdt : request.quantity * stopDistance * (1 + 1e-9),
    maxLeverage: config.maxLeverage,
    maxMarginUsagePercent: config.maxMarginUsagePercent,
    maxTotalMarginUsagePercent: config.maxTotalMarginUsagePercent,
    currentUsedMargin: market.currentUsedMargin,
    marginMode: config.marginMode,
    liquidationSafetyBufferPercent: config.liquidationSafetyBufferPercent,
    entry: price,
    stopLoss: request.stopLoss,
    takeProfit: request.takeProfit,
    minimumRiskReward: config.minimumRiskReward,
    openPositions: market.openPositions,
    maxOpenPositions: config.maxOpenPositions,
    symbolOpenPositions: market.symbolOpenPositions,
    maxPositionPerSymbol: config.maxPositionPerSymbol,
    availableAt: at,
    drawdownPercent: market.drawdownPercent,
    maxDrawdownPercent: config.maxDrawdownPercent,
    // The user asked for this order, so the automatic-trading switch does not apply; the kill switch does.
    tradingEnabled: true,
    killSwitch: config.killSwitch,
    createdAt: at
  });
  // The price used here lets the model correct SL/TP against the same number the risk manager saw.
  if (!risk.accepted) {
    return { ok: false, code: `RISK_${risk.rejectCode ?? "REJECTED"}`, reason: `${risk.reason} (live price ${price}, SL ${request.stopLoss}, TP ${request.takeProfit}, R:R ${round(risk.riskReward)})` };
  }
  return {
    ok: true,
    risk,
    plan: {
      direction: long ? "bullish" : "bearish",
      entry: price,
      structuralStopBoundary: request.stopLoss,
      stopLossBuffer: 0,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      riskReward: risk.riskReward,
      reason: `AI chat order: ${request.reason}`.slice(0, 500),
      origin: "AI"
    }
  };
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}

export function normalizeSymbol(symbol: string): string | null {
  const value = String(symbol ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const withQuote = value.endsWith("USDT") ? value : `${value}USDT`;
  return SYMBOL_PATTERN.test(withQuote) ? withQuote : null;
}
