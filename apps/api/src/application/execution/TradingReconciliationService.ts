import crypto from "node:crypto";
import type { DecisionLogger } from "../ports/Logger.js";
import type { ExecutionIntentRepository } from "./ExecutionIntentRepository.js";
import type { AccountActivitySnapshot } from "../runtime/TradingRuntimeManager.js";
import type { ExecutionIntent, ExecutionIntentStatus } from "./ExecutionIntent.js";
import type { ExecutionOrderLookupResult, RecoverableExecutionGateway } from "../ports/ExecutionGateway.js";
import { isImmediateTriggerError } from "./ExecutionErrors.js";
import type { BinanceFuturesOpenOrderStatus, BinanceFuturesOrderHistoryStatus, BinanceFuturesPositionStatus } from "../../infrastructure/execution/BinanceFuturesAccountClient.js";

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
  private readonly symbolsWithObservedPositions = new Set<string>();

  private readonly repairMaxAttempts = 3;
  private readonly repairTimeoutMs = 5 * 60 * 1000;

  constructor(
    private readonly repository: ExecutionIntentRepository,
    private readonly logger: DecisionLogger,
    private readonly limitEntryTimeoutMs = 15 * 60 * 1000
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
      if (activity.authoritative === false) {
        await this.audit(tradingAccountId, null, null, "RECONCILIATION_STATE_UNKNOWN", { reason: "BINANCE_SIGNED_READ_NOT_AUTHORITATIVE" });
        return { status: "DEGRADED", externalPositions: 0, unprotectedPositions: 0, protectionRepairAttempts: 0, checkedAt, error: "BINANCE_STATE_UNKNOWN" };
      }

      for (const position of activity.positions) {
        if (position.quantity > 0) this.symbolsWithObservedPositions.add(position.symbol);
      }

      // Terminal intents are still needed for authoritative position correlation. A
      // terminal DB row must not hide a live bot-owned Binance position.
      let intents = await this.repository.listByAccount(tradingAccountId, 500);
      const activeIntents = intents.filter((intent) => !isTerminalIntent(intent));
      const knownSymbols = new Set(activeIntents.map((intent) => intent.symbol));
      const botClientOrderIds = new Set(
        intents.flatMap((intent) => [intent.clientEntryOrderId, intent.clientStopOrderId, intent.clientTakeProfitOrderId]).filter((value): value is string => Boolean(value))
      );
      let externalPositions = 0;
      let terminalStateMismatches = 0;
      let ownershipAmbiguous = 0;
      const ownership = resolvePositionOwnership(intents, activity.positions, activity);
      for (const position of activity.positions) {
        const relatedOpenOrders = activity.openOrders.filter((order) => order.symbol === position.symbol);
        const hasKnownOrder = relatedOpenOrders.some((order) => Boolean(order.clientOrderId && botClientOrderIds.has(order.clientOrderId)));
        const owner = ownership.get(position.id);
        const hasKnownIntent = owner?.kind === "owned" || owner?.kind === "ambiguous";
        if (owner?.kind === "ambiguous") {
          ownershipAmbiguous += 1;
          await this.audit(tradingAccountId, null, position.symbol, "BOT_POSITION_OWNERSHIP_AMBIGUOUS", {
            positionQuantity: position.quantity,
            positionEntryPrice: position.entryPrice,
            candidateIntentIds: owner.candidates.map((candidate) => candidate.id)
          });
        }
        if (!knownSymbols.has(position.symbol) && !hasKnownOrder && !hasKnownIntent) {
          externalPositions += 1;
          await this.auditExternalPosition(tradingAccountId, position);
        }
      }

      for (const intent of intents) {
        const owner = [...ownership.values()].find((candidate) => candidate.kind === "owned" && candidate.intent.id === intent.id);
        const ambiguous = [...ownership.values()].some(
          (candidate) => candidate.kind === "ambiguous" && candidate.candidates.some((candidateIntent) => candidateIntent.id === intent.id)
        );
        const reconciled = await this.reconcileIntent(intent, activity, gateway, owner?.position, ambiguous);
        const latest = reconciled.intent;
        if (reconciled.terminalStateMismatch) terminalStateMismatches += 1;
        if (latest) {
          intents = intents.map((item) => (item.id === latest.id ? latest : item));
        }
      }

      await this.cancelOrphanProtectionOrders(tradingAccountId, activity, intents, gateway);

      const unprotectedPositions = activity.positions.filter((position) => position.quantity > 0 && (position.stopLoss === null || position.takeProfit === null)).length;
      const protectionRepairAttempts = intents.reduce((total, intent) => total + (this.repairFailures.get(intent.id)?.attempts ?? 0), 0);

      const reconciliationError =
        terminalStateMismatches > 0
          ? "BOT_POSITION_TERMINAL_STATE_MISMATCH"
          : ownershipAmbiguous > 0
            ? "BOT_POSITION_OWNERSHIP_AMBIGUOUS"
            : unprotectedPositions > 0
              ? "PROTECTION_INCOMPLETE"
              : null;
      await this.audit(tradingAccountId, null, null, reconciliationError ? "RECONCILIATION_PROTECTION_INCOMPLETE" : "RECONCILIATION_SUCCEEDED", {
        openIntents: intents.filter((intent) => !isTerminalIntent(intent)).length,
        externalPositions,
        unprotectedPositions,
        terminalStateMismatches,
        ownershipAmbiguous
      });
      return {
        status: terminalStateMismatches > 0 || ownershipAmbiguous > 0 || unprotectedPositions > 0 ? "DEGRADED" : "OK",
        externalPositions,
        unprotectedPositions,
        protectionRepairAttempts,
        checkedAt,
        error: reconciliationError
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
    gateway: RecoverableExecutionGateway | undefined,
    ownedPosition?: BinanceFuturesPositionStatus,
    ownershipAmbiguous = false
  ): Promise<{ intent: ExecutionIntent | null; terminalStateMismatch: boolean }> {
    let current = intent;
    if (ownershipAmbiguous) return { intent: current, terminalStateMismatch: false };
    const position = ownedPosition;
    let terminalStateMismatch = false;
    const entry = await this.findKnownOrder(activity, current.symbol, current.clientEntryOrderId, gateway);

    if (position && isTerminalIntent(current)) {
      const recovered = await this.repository.transitionStatus(current.id, ["CLOSED", "CANCELLED", "FAILED"], "RECOVERY_REQUIRED", {
        lastError: "BOT_POSITION_TERMINAL_STATE_MISMATCH"
      });
      if (recovered) current = recovered;
      terminalStateMismatch = true;
      await this.audit(current.tradingAccountId, current.id, current.symbol, "BOT_POSITION_TERMINAL_STATE_MISMATCH", {
        positionQuantity: position.quantity,
        previousStatus: intent.status
      });
    }

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

    const expired = await this.cancelExpiredLimitEntry(current, activity, gateway, Boolean(position));
    if (expired) return { intent: expired, terminalStateMismatch };

    if (this.shouldCloseIntent(current, position)) {
      await this.cancelBotOwnedProtectionOrders(current, activity.openOrders, gateway);
      current = (await this.transition(current, "CLOSED", { lastError: null })) ?? current;
      await this.audit(current.tradingAccountId, current.id, current.symbol, "POSITION_CLOSED", { source: "BINANCE_POSITION_ZERO" });
      return { intent: current, terminalStateMismatch };
    }

    if (!position) return { intent: current, terminalStateMismatch };
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
      return { intent: current, terminalStateMismatch };
    }
    if (!["ENTRY_FILLED", "PROTECTION_INCOMPLETE", "RECONCILIATION_REQUIRED", "ENTRY_SUBMITTED", "PROTECTED", "RECOVERY_REQUIRED", "FAIL_SAFE_CLOSE_REQUIRED"].includes(current.status)) {
      return { intent: current, terminalStateMismatch };
    }

    return { intent: await this.repairProtection(current, position, activity.openOrders, gateway, !terminalStateMismatch), terminalStateMismatch };
  }

  // A LIMIT entry that has not filled within the timeout is stale: the setup moment has passed.
  // Any partially filled size stays open and is protected by the closePosition SL/TP.
  private async cancelExpiredLimitEntry(
    intent: ExecutionIntent,
    activity: AccountActivitySnapshot,
    gateway: RecoverableExecutionGateway | undefined,
    hasPosition: boolean
  ): Promise<ExecutionIntent | null> {
    if (!gateway || intent.entryType !== "limit" || !intent.clientEntryOrderId) return null;
    if (!["ENTRY_SUBMITTED", "ENTRY_FILLED", "PROTECTION_INCOMPLETE", "PROTECTED"].includes(intent.status)) return null;
    const openEntry = activity.openOrders.find((order) => order.symbol === intent.symbol && order.clientOrderId === intent.clientEntryOrderId);
    if (!openEntry) return null;
    const ageMs = Date.now() - Date.parse(intent.createdAt);
    if (!Number.isFinite(ageMs) || ageMs < this.limitEntryTimeoutMs) return null;

    await gateway.cancelOrderByClientOrderId(intent.symbol, intent.clientEntryOrderId);
    await this.audit(intent.tradingAccountId, intent.id, intent.symbol, "LIMIT_ENTRY_EXPIRED", { clientEntryOrderId: intent.clientEntryOrderId, ageMs, partiallyFilled: hasPosition });
    if (hasPosition || intent.status !== "ENTRY_SUBMITTED") return null;
    return (await this.transition(intent, "CANCELLED", { lastError: "LIMIT_ENTRY_EXPIRED" })) ?? intent;
  }

  private async repairProtection(
    intent: ExecutionIntent,
    position: BinanceFuturesPositionStatus,
    openOrders: BinanceFuturesOpenOrderStatus[],
    gateway: RecoverableExecutionGateway | undefined,
    allowFailSafeClose = true
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

    if (current.status === "RECOVERY_REQUIRED" && (current.quantity === null || current.requestedStopLoss === null || current.requestedTakeProfit === null)) {
      current = (await this.transition(current, "RECOVERY_REQUIRED", { lastError: "MANUAL_RECOVERY_REQUIRED" })) ?? current;
      await this.audit(current.tradingAccountId, current.id, current.symbol, "MANUAL_RECOVERY_REQUIRED", {});
      return current;
    }

    if (!gateway || current.quantity === null || current.requestedStopLoss === null || current.requestedTakeProfit === null) {
      return this.handleRepairFailure(current, position, gateway, "PROTECTION_REPAIR_REQUIRES_MANUAL_RECONCILIATION", allowFailSafeClose);
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
      return this.handleRepairFailure(current, position, gateway, message, allowFailSafeClose);
    }
  }

  private async handleRepairFailure(
    intent: ExecutionIntent,
    position: BinanceFuturesPositionStatus,
    gateway: RecoverableExecutionGateway | undefined,
    error: string,
    allowFailSafeClose = true
  ): Promise<ExecutionIntent | null> {
    const now = Date.now();
    const persistedFailures = await this.repository.listAuditEvents(intent.tradingAccountId, intent.id, 100);
    const priorPersisted = persistedFailures.filter((event) => ["PROTECTION_REPAIR_FAILED", "PROTECTION_REPAIR_BLOCKED", "FAIL_SAFE_CLOSE_FAILED"].includes(event.type));
    const prior = this.repairFailures.get(intent.id) ?? {
      attempts: priorPersisted.length,
      firstAt: priorPersisted.reduce((first, event) => Math.min(first, Date.parse(event.createdAt) || now), now)
    };
    const failures = { attempts: prior.attempts + 1, firstAt: prior.firstAt };
    this.repairFailures.set(intent.id, failures);
    // A crossed trigger price (-2021) will never succeed on retry; close without waiting.
    const thresholdReached = isImmediateTriggerError(error) || failures.attempts >= this.repairMaxAttempts || now - failures.firstAt >= this.repairTimeoutMs;
    const nextStatus = allowFailSafeClose ? thresholdReached ? "FAIL_SAFE_CLOSE_REQUIRED" : "RECONCILIATION_REQUIRED" : "RECOVERY_REQUIRED";
    const next = (await this.transition(intent, nextStatus, { lastError: error })) ?? intent;
    await this.audit(intent.tradingAccountId, intent.id, intent.symbol, thresholdReached && allowFailSafeClose ? "FAIL_SAFE_CLOSE_REQUIRED" : "PROTECTION_REPAIR_FAILED", { error, attempts: failures.attempts });
    if (!allowFailSafeClose || !thresholdReached || !gateway?.closePosition) return next;
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
      if (openSymbols.has(order.symbol)) continue;
      // Bot exits are closePosition orders: one left over from a finished intent would close the
      // next position opened on this symbol, so it is removed once the symbol is flat.
      const owner = intents.find((intent) => intent.clientStopOrderId === order.clientOrderId || intent.clientTakeProfitOrderId === order.clientOrderId);
      if (owner && isTerminalIntent(owner)) {
        await gateway.cancelOrderByClientOrderId(order.symbol, order.clientOrderId);
        await this.audit(tradingAccountId, owner.id, order.symbol, "STALE_PROTECTION_CANCELLED", { orderId: order.orderId, clientOrderId: order.clientOrderId });
        continue;
      }
      if (this.symbolsWithObservedPositions.has(order.symbol) || requiredIds.has(order.clientOrderId)) continue;
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
  "RECOVERY_REQUIRED",
  "FAIL_SAFE_CLOSE_REQUIRED",
  "BINANCE_CONNECTION_LOST"
];

function isTerminalIntent(intent: ExecutionIntent): boolean {
  return intent.status === "CLOSED" || intent.status === "CANCELLED" || intent.status === "FAILED";
}

type PositionOwnership =
  | { kind: "owned"; intent: ExecutionIntent; position: BinanceFuturesPositionStatus }
  | { kind: "ambiguous"; candidates: ExecutionIntent[]; position: BinanceFuturesPositionStatus };

function resolvePositionOwnership(
  intents: ExecutionIntent[],
  positions: BinanceFuturesPositionStatus[],
  activity: AccountActivitySnapshot
): Map<string, PositionOwnership> {
  const ownership = new Map<string, PositionOwnership>();
  for (const position of positions) {
    const candidates = intents.filter((intent) => matchesBotOwnedPosition(intent, position, activity));
    if (candidates.length === 1) {
      ownership.set(position.id, { kind: "owned", intent: candidates[0]!, position });
    } else if (candidates.length > 1) {
      ownership.set(position.id, { kind: "ambiguous", candidates, position });
    } else {
      const possible = intents.filter((intent) => !isTerminalIntent(intent) && intent.symbol === position.symbol && intent.side === position.side);
      if (possible.length > 0) ownership.set(position.id, { kind: "ambiguous", candidates: possible, position });
    }
  }
  return ownership;
}

function matchesBotOwnedPosition(intent: ExecutionIntent, position: BinanceFuturesPositionStatus, activity: AccountActivitySnapshot): boolean {
  if (intent.source !== "BOT" || intent.symbol !== position.symbol || intent.side !== position.side) return false;
  const entryOrders = [...activity.openOrders, ...activity.orderHistory];
  const matchingOrder = entryOrders.find(
    (order) =>
      order.symbol === position.symbol &&
      isEntryOrder(order.type) &&
      ((intent.binanceEntryOrderId !== null && order.orderId === intent.binanceEntryOrderId) ||
        (intent.clientEntryOrderId !== null && order.clientOrderId === intent.clientEntryOrderId))
  );
  const matchingTrade = activity.tradeHistory.find(
    (trade) =>
      trade.symbol === position.symbol &&
      ((intent.binanceEntryOrderId !== null && trade.orderId === intent.binanceEntryOrderId) ||
        (intent.clientEntryOrderId !== null && trade.orderId === intent.clientEntryOrderId))
  );

  // Historical order/client IDs are not sufficient by themselves: Binance keeps
  // them forever, so an old filled entry can otherwise claim a later position.
  if (matchingTrade && isCompatibleEntryEvidence(intent, position, matchingTrade.price, matchingTrade.quantity, matchingTrade.createdAt)) return true;
  if (
    matchingOrder &&
    isCompatibleEntryEvidence(
      intent,
      position,
      (matchingOrder as BinanceFuturesOrderHistoryStatus).averagePrice ?? matchingOrder.price,
      matchingOrder.executedQuantity || matchingOrder.quantity,
      matchingOrder.updatedAt ?? matchingOrder.createdAt
    )
  ) {
    return true;
  }

  // A live non-terminal intent may be recovered when Binance history is
  // temporarily unavailable, but terminal intents require direct evidence.
  if (isTerminalIntent(intent)) return false;
  return (
    intent.status === "ENTRY_SUBMITTED" ||
    intent.status === "ENTRY_FILLED" ||
    intent.status === "PROTECTED" ||
    intent.status === "PROTECTION_INCOMPLETE" ||
    intent.status === "RECONCILIATION_REQUIRED" ||
    intent.status === "RECOVERY_REQUIRED" ||
    intent.status === "CLOSING" ||
    intent.status === "FAIL_SAFE_CLOSE_REQUIRED"
  ) && approximatelyEqual(position.entryPrice, intent.requestedEntry) && approximatelyEqual(position.quantity, intent.quantity);
}

function isEntryOrder(type: string): boolean {
  return type === "MARKET" || type === "LIMIT" || type === "STOP" || type === "TAKE_PROFIT";
}

function isCompatibleEntryEvidence(
  intent: ExecutionIntent,
  position: BinanceFuturesPositionStatus,
  entryPrice: number | null,
  quantity: number,
  evidenceTime: number | null
): boolean {
  if (!approximatelyEqual(position.entryPrice, entryPrice) || !approximatelyEqual(position.quantity, quantity)) return false;
  if (position.entryTime !== null && evidenceTime !== null && Math.abs(position.entryTime - evidenceTime) > 5 * 60) return false;
  if (intent.createdAt && position.entryTime !== null) {
    const intentTime = Date.parse(intent.createdAt) / 1000;
    if (Number.isFinite(intentTime) && position.entryTime + 5 * 60 < intentTime) return false;
  }
  return true;
}

function approximatelyEqual(left: number | null, right: number | null, relativeTolerance = 0.005): boolean {
  if (left === null || right === null || !Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return false;
  return Math.abs(left - right) <= Math.max(Math.abs(left), Math.abs(right)) * relativeTolerance;
}

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
