import crypto from "node:crypto";
import type { DecisionLogger } from "../ports/Logger.js";
import type { ExecutionIntentRepository } from "./ExecutionIntentRepository.js";
import type { AccountActivitySnapshot } from "../runtime/TradingRuntimeManager.js";
import type { ExecutionIntent, ExecutionIntentStatus } from "./ExecutionIntent.js";
import type { ExecutionOrderLookupResult, RecoverableExecutionGateway } from "../ports/ExecutionGateway.js";
import type { BinanceFuturesOpenOrderStatus, BinanceFuturesPositionStatus } from "../../infrastructure/execution/BinanceFuturesAccountClient.js";

export interface ReconciliationResult {
  status: "OK" | "DEGRADED" | "CONNECTION_LOST";
  externalPositions: number;
  unprotectedPositions: number;
  protectionRepairAttempts: number;
  checkedAt: string;
  error: string | null;
}

export class TradingReconciliationService {
  private readonly recentExternalAudits = new Map<string, number>();
  private readonly repairFailures = new Map<string, { attempts: number; firstAt: number }>();

  private readonly repairMaxAttempts = 3;
  private readonly repairTimeoutMs = 5 * 60 * 1000;

  constructor(
    private readonly repository: ExecutionIntentRepository,
    private readonly logger: DecisionLogger
  ) {}

  async reconcile(
    tradingAccountId: string,
    readActivity: () => Promise<AccountActivitySnapshot>,
    gateway?: RecoverableExecutionGateway
  ): Promise<ReconciliationResult> {
    const checkedAt = new Date().toISOString();
    try {
      const activity = await readActivity();
      if (!activity.connected) {
        await this.audit(tradingAccountId, null, null, "RECONCILIATION_CONNECTION_LOST", {});
        return { status: "CONNECTION_LOST", externalPositions: 0, unprotectedPositions: 0, protectionRepairAttempts: 0, checkedAt, error: null };
      }

      let intents = await this.repository.listOpenByAccount(tradingAccountId);
      const knownSymbols = new Set(intents.map((intent) => intent.symbol));
      const botClientOrderIds = new Set(
        intents.flatMap((intent) => [intent.clientEntryOrderId, intent.clientStopOrderId, intent.clientTakeProfitOrderId]).filter((value): value is string => Boolean(value))
      );
      let externalPositions = 0;
      for (const position of activity.positions) {
        const relatedOpenOrders = activity.openOrders.filter((order) => order.symbol === position.symbol);
        const hasKnownOrder = relatedOpenOrders.some((order) => Boolean(order.clientOrderId && botClientOrderIds.has(order.clientOrderId)));
        if (!knownSymbols.has(position.symbol) && !hasKnownOrder) {
          externalPositions += 1;
          await this.auditExternalPosition(tradingAccountId, position);
        }
      }

      for (const intent of intents) {
        const latest = await this.reconcileIntent(intent, activity, gateway);
        if (latest) {
          intents = intents.map((item) => (item.id === latest.id ? latest : item));
        }
      }

      await this.cancelOrphanProtectionOrders(tradingAccountId, activity, intents, gateway);

      const unprotectedPositions = activity.positions.filter((position) => position.quantity > 0 && (position.stopLoss === null || position.takeProfit === null)).length;
      const protectionRepairAttempts = intents.reduce((total, intent) => total + (this.repairFailures.get(intent.id)?.attempts ?? 0), 0);

      await this.audit(tradingAccountId, null, null, unprotectedPositions > 0 ? "RECONCILIATION_PROTECTION_INCOMPLETE" : "RECONCILIATION_SUCCEEDED", { openIntents: intents.length, externalPositions, unprotectedPositions });
      return {
        status: unprotectedPositions > 0 ? "DEGRADED" : "OK",
        externalPositions,
        unprotectedPositions,
        protectionRepairAttempts,
        checkedAt,
        error: unprotectedPositions > 0 ? "PROTECTION_INCOMPLETE" : null
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("Trading reconciliation failed", { tradingAccountId, error: message });
      await this.audit(tradingAccountId, null, null, "RECONCILIATION_FAILED", { error: message });
      return { status: "DEGRADED", externalPositions: 0, unprotectedPositions: 0, protectionRepairAttempts: 0, checkedAt, error: message };
    }
  }

  private async reconcileIntent(
    intent: ExecutionIntent,
    activity: AccountActivitySnapshot,
    gateway: RecoverableExecutionGateway | undefined
  ): Promise<ExecutionIntent | null> {
    let current = intent;
    const position = activity.positions.find((item) => item.symbol === current.symbol && item.side === current.side);
    const entry = await this.findKnownOrder(activity, current.symbol, current.clientEntryOrderId, gateway);

    if (entry && !current.binanceEntryOrderId && ["ENTRY_SUBMITTING", "RECONCILIATION_REQUIRED", "ENTRY_SUBMITTED"].includes(current.status)) {
      const entryStatus = isFilled(entry.status) || entry.executedQuantity > 0 ? "ENTRY_FILLED" : "ENTRY_SUBMITTED";
      current =
        (await this.transition(current, entryStatus, {
          binanceEntryOrderId: entry.orderId,
          clientEntryOrderId: entry.clientOrderId,
          lastError: null
        })) ?? current;
      await this.audit(current.tradingAccountId, current.id, current.symbol, "ENTRY_RECOVERED_BY_LOOKUP", {
        orderId: entry.orderId,
        clientOrderId: entry.clientOrderId,
        binanceStatus: entry.status
      });
    }

    if (position && ["ENTRY_SUBMITTED", "RECONCILIATION_REQUIRED"].includes(current.status)) {
      current = (await this.transition(current, "ENTRY_FILLED", { lastError: null })) ?? current;
      await this.audit(current.tradingAccountId, current.id, current.symbol, "ENTRY_FILLED_BY_POSITION", {
        quantity: position.quantity,
        entryPrice: position.entryPrice
      });
    }

    if (this.shouldCloseIntent(current, position)) {
      await this.cancelBotOwnedProtectionOrders(current, activity.openOrders, gateway);
      current = (await this.transition(current, "CLOSED", { lastError: null })) ?? current;
      await this.audit(current.tradingAccountId, current.id, current.symbol, "POSITION_CLOSED", { source: "BINANCE_POSITION_ZERO" });
      return current;
    }

    if (!position) return current;
    if (current.status === "CLOSING") {
      if (gateway?.closePosition) {
        try {
          const exitSide = current.side === "long" ? "SELL" : "BUY";
          const closed = await gateway.closePosition({ symbol: current.symbol, side: exitSide, quantity: position.quantity, clientOrderId: `smc_${current.id.replace(/-/g, "").slice(0, 24)}_C` });
          await this.audit(current.tradingAccountId, current.id, current.symbol, "FAIL_SAFE_CLOSE_RETRIED", { orderId: closed.orderId });
        } catch (error) {
          await this.audit(current.tradingAccountId, current.id, current.symbol, "FAIL_SAFE_CLOSE_FAILED", { error: error instanceof Error ? error.message : String(error) });
        }
      }
      return current;
    }
    if (!["ENTRY_FILLED", "PROTECTION_INCOMPLETE", "RECONCILIATION_REQUIRED", "ENTRY_SUBMITTED", "PROTECTED", "FAIL_SAFE_CLOSE_REQUIRED"].includes(current.status)) return current;

    return this.repairProtection(current, position, activity.openOrders, gateway);
  }

  private async repairProtection(
    intent: ExecutionIntent,
    position: BinanceFuturesPositionStatus,
    openOrders: BinanceFuturesOpenOrderStatus[],
    gateway: RecoverableExecutionGateway | undefined
  ): Promise<ExecutionIntent | null> {
    let current = intent;
    const exitSide = current.side === "long" ? "SELL" : "BUY";
    const stop = findBotOrder(openOrders, current.clientStopOrderId, "STOP_MARKET", exitSide);
    const takeProfit = findBotOrder(openOrders, current.clientTakeProfitOrderId, "TAKE_PROFIT_MARKET", exitSide);
    const patch: Partial<ExecutionIntent> = {};
    if (stop?.orderId && !current.binanceStopOrderId) patch.binanceStopOrderId = stop.orderId;
    if (takeProfit?.orderId && !current.binanceTakeProfitOrderId) patch.binanceTakeProfitOrderId = takeProfit.orderId;
    if (Object.keys(patch).length > 0) {
      current = (await this.transition(current, current.status, patch)) ?? current;
    }

    // Persisted Binance IDs are correlation hints only. Current Binance state is authoritative.
    const hasStop = Boolean(stop);
    const hasTakeProfit = Boolean(takeProfit);
    if (hasStop && hasTakeProfit) {
      if (current.status !== "PROTECTED") {
        current = (await this.transition(current, "PROTECTED", { lastError: null })) ?? current;
        await this.audit(current.tradingAccountId, current.id, current.symbol, "POSITION_PROTECTED_BY_RECONCILIATION", {});
      }
      return current;
    }

    if (!gateway || current.quantity === null || current.requestedStopLoss === null || current.requestedTakeProfit === null) {
      return this.handleRepairFailure(current, position, gateway, "PROTECTION_REPAIR_REQUIRES_MANUAL_RECONCILIATION");
    }

    const quantity = position.quantity || current.quantity;
    const requestedStopLoss = current.requestedStopLoss;
    const requestedTakeProfit = current.requestedTakeProfit;
    if (quantity === null || requestedStopLoss === null || requestedTakeProfit === null) {
      current = (await this.transition(current, "RECONCILIATION_REQUIRED", { lastError: "PROTECTION_REPAIR_MISSING_PRICES" })) ?? current;
      return current;
    }
    try {
      if (!hasStop && current.clientStopOrderId) {
        const repaired = await gateway.submitProtectionOrder({
          symbol: current.symbol,
          side: exitSide,
          type: "STOP_MARKET",
          quantity,
          stopPrice: requestedStopLoss,
          clientOrderId: current.clientStopOrderId
        });
        const verified = gateway.findProtectionOrder ? await gateway.findProtectionOrder(current.symbol, "STOP_MARKET", exitSide, current.clientStopOrderId) : repaired;
        if (!verified) throw new Error("STOP_LOSS_REPAIR_NOT_VERIFIED");
        current = (await this.transition(current, "PROTECTION_INCOMPLETE", { binanceStopOrderId: verified.orderId, lastError: null })) ?? current;
        await this.audit(current.tradingAccountId, current.id, current.symbol, "STOP_LOSS_REPAIRED", { orderId: verified.orderId });
      }
      if (!hasTakeProfit && current.clientTakeProfitOrderId) {
        const repaired = await gateway.submitProtectionOrder({
          symbol: current.symbol,
          side: exitSide,
          type: "TAKE_PROFIT_MARKET",
          quantity,
          stopPrice: requestedTakeProfit,
          clientOrderId: current.clientTakeProfitOrderId
        });
        const verified = gateway.findProtectionOrder ? await gateway.findProtectionOrder(current.symbol, "TAKE_PROFIT_MARKET", exitSide, current.clientTakeProfitOrderId) : repaired;
        if (!verified) throw new Error("TAKE_PROFIT_REPAIR_NOT_VERIFIED");
        current = (await this.transition(current, "PROTECTION_INCOMPLETE", { binanceTakeProfitOrderId: verified.orderId, lastError: null })) ?? current;
        await this.audit(current.tradingAccountId, current.id, current.symbol, "TAKE_PROFIT_REPAIRED", { orderId: verified.orderId });
      }
      this.repairFailures.delete(current.id);
      current = (await this.transition(current, "PROTECTED", { lastError: null })) ?? current;
      await this.audit(current.tradingAccountId, current.id, current.symbol, "POSITION_PROTECTED_BY_REPAIR", {});
      return current;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.handleRepairFailure(current, position, gateway, message);
    }
  }

  private async handleRepairFailure(intent: ExecutionIntent, position: BinanceFuturesPositionStatus, gateway: RecoverableExecutionGateway | undefined, error: string): Promise<ExecutionIntent | null> {
    const now = Date.now();
    const persistedFailures = await this.repository.listAuditEvents(intent.tradingAccountId, intent.id, 100);
    const priorPersisted = persistedFailures.filter((event) => ["PROTECTION_REPAIR_FAILED", "PROTECTION_REPAIR_BLOCKED", "FAIL_SAFE_CLOSE_FAILED"].includes(event.type));
    const prior = this.repairFailures.get(intent.id) ?? {
      attempts: priorPersisted.length,
      firstAt: priorPersisted.reduce((first, event) => Math.min(first, Date.parse(event.createdAt) || now), now)
    };
    const failures = { attempts: prior.attempts + 1, firstAt: prior.firstAt };
    this.repairFailures.set(intent.id, failures);
    const thresholdReached = failures.attempts >= this.repairMaxAttempts || now - failures.firstAt >= this.repairTimeoutMs;
    const next = (await this.transition(intent, thresholdReached ? "FAIL_SAFE_CLOSE_REQUIRED" : "RECONCILIATION_REQUIRED", { lastError: error })) ?? intent;
    await this.audit(intent.tradingAccountId, intent.id, intent.symbol, thresholdReached ? "FAIL_SAFE_CLOSE_REQUIRED" : "PROTECTION_REPAIR_FAILED", { error, attempts: failures.attempts });
    if (!thresholdReached || !gateway?.closePosition) return next;
    try {
      const exitSide = intent.side === "long" ? "SELL" : "BUY";
      const closed = await gateway.closePosition({ symbol: intent.symbol, side: exitSide, quantity: position.quantity, clientOrderId: `smc_${intent.id.replace(/-/g, "").slice(0, 24)}_C` });
      await this.audit(intent.tradingAccountId, intent.id, intent.symbol, "FAIL_SAFE_CLOSE_SUBMITTED", { orderId: closed.orderId, attempts: failures.attempts });
      return (await this.transition(next, "CLOSING", { lastError: null })) ?? next;
    } catch (closeError) {
      const message = closeError instanceof Error ? closeError.message : String(closeError);
      await this.audit(intent.tradingAccountId, intent.id, intent.symbol, "FAIL_SAFE_CLOSE_FAILED", { error: message });
      return (await this.transition(next, "FAIL_SAFE_CLOSE_REQUIRED", { lastError: message })) ?? next;
    }
  }

  private async findKnownOrder(
    activity: AccountActivitySnapshot,
    symbol: string,
    clientOrderId: string | null,
    gateway: RecoverableExecutionGateway | undefined
  ): Promise<ExecutionOrderLookupResult | null> {
    if (!clientOrderId) return null;
    const open = activity.openOrders.find((order) => order.symbol === symbol && order.clientOrderId === clientOrderId);
    if (open) return toLookup(open);
    const historical = activity.orderHistory.find((order) => order.symbol === symbol && order.clientOrderId === clientOrderId);
    if (historical) return toLookup(historical);
    return gateway ? gateway.findOrderByClientOrderId(symbol, clientOrderId) : null;
  }

  private shouldCloseIntent(intent: ExecutionIntent, position: BinanceFuturesPositionStatus | undefined): boolean {
    if (position) return false;
    if (!["ENTRY_FILLED", "PROTECTION_INCOMPLETE", "PROTECTED", "CLOSING", "RECONCILIATION_REQUIRED"].includes(intent.status)) return false;
    return Boolean(intent.binanceEntryOrderId || intent.clientEntryOrderId);
  }

  private async cancelBotOwnedProtectionOrders(
    intent: ExecutionIntent,
    openOrders: BinanceFuturesOpenOrderStatus[],
    gateway: RecoverableExecutionGateway | undefined
  ): Promise<void> {
    if (!gateway) return;
    const protectionIds = new Set([intent.clientStopOrderId, intent.clientTakeProfitOrderId].filter((value): value is string => Boolean(value)));
    const botOwnedOrders = openOrders.filter((order) => order.symbol === intent.symbol && order.clientOrderId && protectionIds.has(order.clientOrderId));
    for (const order of botOwnedOrders) {
      if (!order.clientOrderId) continue;
      await gateway.cancelOrderByClientOrderId(order.symbol, order.clientOrderId);
      await this.audit(intent.tradingAccountId, intent.id, intent.symbol, "STALE_PROTECTION_CANCELLED", {
        orderId: order.orderId,
        clientOrderId: order.clientOrderId
      });
    }
  }

  private async cancelOrphanProtectionOrders(tradingAccountId: string, activity: AccountActivitySnapshot, intents: ExecutionIntent[], gateway: RecoverableExecutionGateway | undefined): Promise<void> {
    if (!gateway) return;
    const openSymbols = new Set(activity.positions.filter((position) => position.quantity > 0).map((position) => position.symbol));
    const requiredIds = new Set(intents.flatMap((intent) => [intent.clientStopOrderId, intent.clientTakeProfitOrderId]).filter((id): id is string => Boolean(id)));
    for (const order of activity.openOrders) {
      if (!order.clientOrderId?.startsWith("smc_") || !["STOP_MARKET", "TAKE_PROFIT_MARKET"].includes(order.type)) continue;
      if (openSymbols.has(order.symbol) || requiredIds.has(order.clientOrderId)) continue;
      await gateway.cancelOrderByClientOrderId(order.symbol, order.clientOrderId);
      await this.audit(tradingAccountId, null, order.symbol, "ORPHAN_PROTECTION_CANCELLED", { orderId: order.orderId, clientOrderId: order.clientOrderId });
    }
  }

  private async transition(intent: ExecutionIntent, next: ExecutionIntentStatus, patch: Partial<ExecutionIntent> = {}): Promise<ExecutionIntent | null> {
    return this.repository.transitionStatus(intent.id, OPEN_STATUSES, next, patch);
  }

  private async audit(tradingAccountId: string, executionIntentId: string | null, symbol: string | null, type: string, metadata: Record<string, unknown>): Promise<void> {
    await this.repository.saveAuditEvent({
      id: crypto.randomUUID(),
      tradingAccountId,
      executionIntentId,
      symbol,
      type,
      metadata,
      createdAt: new Date().toISOString()
    });
  }

  private async auditExternalPosition(tradingAccountId: string, position: BinanceFuturesPositionStatus): Promise<void> {
    const key = `${tradingAccountId}:${position.symbol}:${position.side}`;
    const now = Date.now();
    const previous = this.recentExternalAudits.get(key) ?? 0;
    if (now - previous < 15 * 60 * 1000) return;
    this.recentExternalAudits.set(key, now);
    await this.audit(tradingAccountId, null, position.symbol, "EXTERNAL_POSITION_DETECTED", {
      side: position.side,
      quantity: position.quantity,
      source: "EXTERNAL",
      state: "UNMANAGED_OR_RECOVERY_REQUIRED"
    });
  }
}

const OPEN_STATUSES: ExecutionIntentStatus[] = [
  "CREATED",
  "RISK_APPROVED",
  "ENTRY_SUBMITTING",
  "ENTRY_SUBMITTED",
  "ENTRY_FILLED",
  "PROTECTION_SUBMITTING",
  "PROTECTED",
  "PROTECTION_INCOMPLETE",
  "CLOSING",
  "RECONCILIATION_REQUIRED",
  "FAIL_SAFE_CLOSE_REQUIRED",
  "BINANCE_CONNECTION_LOST"
];

function findBotOrder(openOrders: BinanceFuturesOpenOrderStatus[], clientOrderId: string | null, type: "STOP_MARKET" | "TAKE_PROFIT_MARKET", exitSide: "BUY" | "SELL"): BinanceFuturesOpenOrderStatus | null {
  if (!clientOrderId) return null;
  return openOrders.find((order) => order.clientOrderId === clientOrderId && order.type === type && order.side === exitSide && order.reduceOnly) ?? null;
}

function isFilled(status: string): boolean {
  return status === "FILLED" || status === "PARTIALLY_FILLED";
}

function toLookup(order: BinanceFuturesOpenOrderStatus): ExecutionOrderLookupResult {
  const averagePrice = "averagePrice" in order && typeof order.averagePrice === "number" ? order.averagePrice : null;
  return {
    orderId: order.orderId,
    clientOrderId: order.clientOrderId ?? order.orderId,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    reduceOnly: order.reduceOnly,
    originalQuantity: order.quantity,
    executedQuantity: order.executedQuantity,
    averagePrice
  };
}
