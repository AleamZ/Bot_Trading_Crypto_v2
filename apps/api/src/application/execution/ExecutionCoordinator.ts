import crypto from "node:crypto";
import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";
import type { DecisionLogger } from "../ports/Logger.js";
import type { ExecutionGateway, SubmittedOrder } from "../ports/ExecutionGateway.js";
import { isRecoverableExecutionGateway } from "../ports/ExecutionGateway.js";
import { buildSetupKey, sideFromDirection, type ExecutionIntent, type ExecutionIntentStatus } from "./ExecutionIntent.js";
import type { ExecutionIntentRepository } from "./ExecutionIntentRepository.js";
import { classifyExecutionError } from "./ExecutionErrors.js";
import { isPostEntryProtectionError } from "./PostEntryProtectionError.js";
import { backoffDelay, sleep, type RetryPolicyOptions } from "./RetryPolicy.js";

export interface ExecutionCoordinatorOptions {
  tradingAccountId: string;
  mode: "DEMO" | "REAL";
  entryType: "limit" | "market" | (() => "limit" | "market");
  repository: ExecutionIntentRepository;
  delegate: ExecutionGateway;
  logger: DecisionLogger;
  retry: RetryPolicyOptions;
  runtimeReady?: () => boolean;
  executionGate?: () => ExecutionGateState;
  preTradeValidation?: (plan: EntryPlan, risk: RiskDecision) => Promise<void> | void;
}

export type ExecutionGateReason =
  | "READY"
  | "TRADING_DISABLED"
  | "KILL_SWITCH"
  | "BINANCE_DISCONNECTED"
  | "RUNTIME_NOT_READY"
  | "RECONCILIATION_REQUIRED"
  | "REAL_EXECUTION_LOCKED"
  | "READ_ONLY_SOAK_EXECUTION_BLOCKED"
  | "SHUTTING_DOWN";

export interface ExecutionGateState {
  enabled: boolean;
  reason: ExecutionGateReason;
}

export class ExecutionCoordinator implements ExecutionGateway {
  constructor(private readonly options: ExecutionCoordinatorOptions) {}

  async submitBracketOrder(plan: EntryPlan, risk: RiskDecision): Promise<SubmittedOrder> {
    if (this.options.mode !== "DEMO") {
      await this.options.repository.saveAuditEvent({
        id: crypto.randomUUID(),
        tradingAccountId: this.options.tradingAccountId,
        executionIntentId: null,
        symbol: risk.symbol,
        type: "REAL_EXECUTION_BLOCKED",
        metadata: { reason: "REAL_EXECUTION_LOCKED" },
        createdAt: new Date().toISOString()
      });
      throw new Error("REAL_EXECUTION_LOCKED");
    }
    const gate = this.executionGate();
    if (!gate.enabled) throw new Error(gate.reason);
    if (!risk.accepted) throw new Error("Risk is not approved");
    await this.options.preTradeValidation?.(plan, risk);

    const setupKey = buildSetupKey(this.options.tradingAccountId, plan, risk);
    const intentId = deterministicUuid(`${this.options.tradingAccountId}:${setupKey}`);
    const clientIds = clientOrderIds(intentId);
    const { intent, created } = await this.options.repository.createOrGet({
      id: intentId,
      tradingAccountId: this.options.tradingAccountId,
      symbol: risk.symbol,
      side: sideFromDirection(plan.direction),
      setupKey,
      entryType: typeof this.options.entryType === "function" ? this.options.entryType() : this.options.entryType,
      requestedEntry: plan.entry,
      requestedStopLoss: plan.stopLoss,
      requestedTakeProfit: plan.takeProfit,
      quantity: risk.quantity,
      clientEntryOrderId: clientIds.entry,
      clientStopOrderId: clientIds.stop,
      clientTakeProfitOrderId: clientIds.takeProfit
    });
    if (created) await this.audit("EXECUTION_INTENT_CREATED", intent, { setupKey });

    const duplicate = orderFromExistingIntent(intent);
    if (duplicate) {
      await this.audit("DUPLICATE_PREVENTED", intent, { status: intent.status, setupKey });
      return duplicate;
    }

    if (!canSubmitEntry(intent.status)) {
      await this.audit("DUPLICATE_PREVENTED", intent, { status: intent.status, setupKey });
      throw new Error("RECONCILIATION_REQUIRED");
    }

    const riskApproved = await this.options.repository.transitionStatus(intent.id, ["CREATED"], "RISK_APPROVED");
    const beforeSubmit = await this.options.repository.transitionStatus((riskApproved ?? intent).id, ["RISK_APPROVED"], "ENTRY_SUBMITTING");
    if (!beforeSubmit) {
      const latest = await this.options.repository.findBySetupKey(this.options.tradingAccountId, setupKey);
      const latestOrder = latest ? orderFromExistingIntent(latest) : null;
      if (latestOrder) return latestOrder;
      throw new Error("RECONCILIATION_REQUIRED");
    }

    await this.audit("ENTRY_SUBMIT_STARTED", beforeSubmit, { clientEntryOrderId: beforeSubmit.clientEntryOrderId });

    const context = {
      executionIntentId: beforeSubmit.id,
      setupKey,
      clientEntryOrderId: beforeSubmit.clientEntryOrderId ?? clientIds.entry,
      clientStopOrderId: beforeSubmit.clientStopOrderId ?? clientIds.stop,
      clientTakeProfitOrderId: beforeSubmit.clientTakeProfitOrderId ?? clientIds.takeProfit
    };

    try {
      const order = await this.submitWithClientLookup(plan, risk, beforeSubmit, context);

      // A resting LIMIT entry stays ENTRY_SUBMITTED; reconciliation protects it once filled or cancels it on timeout.
      const protectedStatus = order.entryFilled === false ? "ENTRY_SUBMITTED" : order.stopLossOrderId && order.takeProfitOrderId ? "PROTECTED" : "PROTECTION_INCOMPLETE";
      await this.options.repository.transitionStatus(beforeSubmit.id, ["ENTRY_SUBMITTING", "ENTRY_SUBMITTED", "ENTRY_FILLED"], protectedStatus, {
        binanceEntryOrderId: order.orderId,
        binanceStopOrderId: order.stopLossOrderId ?? null,
        binanceTakeProfitOrderId: order.takeProfitOrderId ?? null,
        clientEntryOrderId: order.clientEntryOrderId ?? beforeSubmit.clientEntryOrderId,
        clientStopOrderId: order.clientStopOrderId ?? beforeSubmit.clientStopOrderId,
        clientTakeProfitOrderId: order.clientTakeProfitOrderId ?? beforeSubmit.clientTakeProfitOrderId,
        lastError: null
      });
      await this.audit("ENTRY_ACCEPTED", beforeSubmit, { orderId: order.orderId, clientEntryOrderId: beforeSubmit.clientEntryOrderId });
      if (protectedStatus === "PROTECTED") await this.audit("POSITION_PROTECTED", beforeSubmit, { stopOrderId: order.stopLossOrderId, takeProfitOrderId: order.takeProfitOrderId });
      return withClientIds(order, beforeSubmit);
    } catch (error) {
      const classified = classifyExecutionError(error);
      const nextStatus = classified.ambiguous ? "RECONCILIATION_REQUIRED" : "FAILED";
      await this.options.repository.transitionStatus(beforeSubmit.id, ["ENTRY_SUBMITTING"], nextStatus, { lastError: `${classified.code}: ${classified.message}` });
      await this.audit("EXECUTION_FAILED", beforeSubmit, { code: classified.code, ambiguous: classified.ambiguous });
      this.options.logger.warn("Execution submission failed", {
        tradingAccountId: this.options.tradingAccountId,
        executionIntentId: beforeSubmit.id,
        symbol: risk.symbol,
        code: classified.code
      });
      throw new Error(classified.ambiguous ? "RECONCILIATION_REQUIRED" : classified.code);
    }
  }

  private async submitWithClientLookup(
    plan: EntryPlan,
    risk: RiskDecision,
    intent: ExecutionIntent,
    context: {
      executionIntentId: string;
      setupKey: string;
      clientEntryOrderId: string;
      clientStopOrderId: string;
      clientTakeProfitOrderId: string;
    }
  ): Promise<SubmittedOrder> {
    const attempts = Math.max(1, this.options.retry.maxAttempts);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.options.delegate.submitBracketOrder(plan, risk, context);
      } catch (error) {
        lastError = error;
        if (isPostEntryProtectionError(error)) {
          await this.options.repository.transitionStatus(intent.id, ["ENTRY_SUBMITTING"], "ENTRY_FILLED", {
            binanceEntryOrderId: error.submittedOrder.orderId,
            binanceStopOrderId: error.submittedOrder.stopLossOrderId ?? null,
            binanceTakeProfitOrderId: error.submittedOrder.takeProfitOrderId ?? null,
            clientEntryOrderId: error.submittedOrder.clientEntryOrderId ?? context.clientEntryOrderId,
            clientStopOrderId: error.submittedOrder.clientStopOrderId ?? context.clientStopOrderId,
            clientTakeProfitOrderId: error.submittedOrder.clientTakeProfitOrderId ?? context.clientTakeProfitOrderId,
            lastError: null
          });
          await this.audit("PROTECTION_INCOMPLETE_AFTER_ENTRY", intent, {
            orderId: error.submittedOrder.orderId,
            stopOrderId: error.submittedOrder.stopLossOrderId ?? null,
            takeProfitOrderId: error.submittedOrder.takeProfitOrderId ?? null,
            error: error.message
          });
          return error.submittedOrder;
        }
        const classified = classifyExecutionError(error);
        if (classified.ambiguous && isRecoverableExecutionGateway(this.options.delegate)) {
          const found = await this.options.delegate.findOrderByClientOrderId(risk.symbol, context.clientEntryOrderId);
          if (found) {
            const status = found.status === "FILLED" || found.executedQuantity > 0 ? "ENTRY_FILLED" : "ENTRY_SUBMITTED";
            await this.options.repository.transitionStatus(intent.id, ["ENTRY_SUBMITTING"], status, {
              binanceEntryOrderId: found.orderId,
              clientEntryOrderId: found.clientOrderId,
              lastError: null
            });
            await this.audit("ENTRY_ACCEPTED_BY_LOOKUP", intent, {
              orderId: found.orderId,
              clientEntryOrderId: found.clientOrderId,
              binanceStatus: found.status
            });
            return {
              orderId: found.orderId,
              clientEntryOrderId: found.clientOrderId,
              clientStopOrderId: context.clientStopOrderId,
              clientTakeProfitOrderId: context.clientTakeProfitOrderId,
              mode: "testnet"
            };
          }
        }
        if (attempt >= attempts || !classified.retryable) break;
        await sleep(backoffDelay(this.options.retry.baseDelayMs, attempt));
      }
    }
    throw lastError;
  }

  private async audit(type: string, intent: ExecutionIntent, metadata: Record<string, unknown>): Promise<void> {
    await this.options.repository.saveAuditEvent({
      id: crypto.randomUUID(),
      tradingAccountId: this.options.tradingAccountId,
      executionIntentId: intent.id,
      symbol: intent.symbol,
      type,
      metadata,
      createdAt: new Date().toISOString()
    });
  }

  private executionGate(): ExecutionGateState {
    if (this.options.executionGate) return this.options.executionGate();
    if (this.options.runtimeReady?.()) return { enabled: true, reason: "READY" };
    return { enabled: false, reason: "RECONCILIATION_REQUIRED" };
  }
}

function canSubmitEntry(status: ExecutionIntentStatus): boolean {
  return status === "CREATED" || status === "RISK_APPROVED";
}

function orderFromExistingIntent(intent: ExecutionIntent): SubmittedOrder | null {
  if (!["ENTRY_SUBMITTED", "ENTRY_FILLED", "PROTECTION_SUBMITTING", "PROTECTED", "PROTECTION_INCOMPLETE", "CLOSING", "CLOSED"].includes(intent.status)) return null;
  if (!intent.binanceEntryOrderId) return null;
  return {
    orderId: intent.binanceEntryOrderId,
    ...(intent.binanceStopOrderId ? { stopLossOrderId: intent.binanceStopOrderId } : {}),
    ...(intent.binanceTakeProfitOrderId ? { takeProfitOrderId: intent.binanceTakeProfitOrderId } : {}),
    ...(intent.clientEntryOrderId ? { clientEntryOrderId: intent.clientEntryOrderId } : {}),
    ...(intent.clientStopOrderId ? { clientStopOrderId: intent.clientStopOrderId } : {}),
    ...(intent.clientTakeProfitOrderId ? { clientTakeProfitOrderId: intent.clientTakeProfitOrderId } : {}),
    mode: "testnet"
  };
}

function withClientIds(order: SubmittedOrder, intent: ExecutionIntent): SubmittedOrder {
  return {
    ...order,
    ...(order.clientEntryOrderId || intent.clientEntryOrderId ? { clientEntryOrderId: order.clientEntryOrderId ?? intent.clientEntryOrderId ?? "" } : {}),
    ...(order.clientStopOrderId || intent.clientStopOrderId ? { clientStopOrderId: order.clientStopOrderId ?? intent.clientStopOrderId ?? "" } : {}),
    ...(order.clientTakeProfitOrderId || intent.clientTakeProfitOrderId ? { clientTakeProfitOrderId: order.clientTakeProfitOrderId ?? intent.clientTakeProfitOrderId ?? "" } : {})
  };
}

function clientOrderIds(intentId: string): { entry: string; stop: string; takeProfit: string } {
  const short = intentId.replace(/-/g, "").slice(0, 24);
  return {
    entry: `smc_${short}_E`,
    stop: `smc_${short}_S`,
    takeProfit: `smc_${short}_T`
  };
}

function deterministicUuid(input: string): string {
  const hex = crypto.createHash("sha256").update(input).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}
