import crypto from "node:crypto";
import type { AppConfig } from "../config/AppConfig.js";
import type { ExecutionGateway, SubmittedOrder } from "../ports/ExecutionGateway.js";
import type { DecisionLogger } from "../ports/Logger.js";
import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";
import { buildSetupKey } from "./ExecutionIntent.js";
import { fingerprintProposal, type CreateRealExecutionProposalInput, type RealExecutionProposal, type RealExecutionProposalStatus } from "./RealExecutionProposal.js";
import type { RealExecutionProposalRepository } from "./RealExecutionProposalRepository.js";
import type { ExecutionIntentRepository } from "./ExecutionIntentRepository.js";
import { normalizePrice, validateAgainstSymbolRules, type FuturesSymbolRules } from "../../domain/symbol/SymbolRules.js";

export interface RealExecutionProposalGatewayOptions {
  tradingAccountId: string;
  config: () => AppConfig;
  runtimeReady: () => boolean;
  reconciliationHealthy: () => boolean;
  binanceConnected: () => boolean;
  loadSymbolRules: (symbol: string) => Promise<FuturesSymbolRules>;
  loadAvailableBalance: () => Promise<number | null>;
  assertAccountProtection: () => Promise<void>;
  proposalRepository: RealExecutionProposalRepository;
  auditRepository: ExecutionIntentRepository;
  logger: DecisionLogger;
}

export class RealExecutionProposalGateway implements ExecutionGateway {
  constructor(private readonly options: RealExecutionProposalGatewayOptions) {}

  async submitBracketOrder(plan: EntryPlan, risk: RiskDecision): Promise<SubmittedOrder> {
    const config = this.options.config();
    this.assertGate(config);
    await this.options.assertAccountProtection();
    const rules = await this.options.loadSymbolRules(risk.symbol);
    const validation = validateAgainstSymbolRules(rules, {
      symbol: risk.symbol,
      orderType: config.entryMode.toUpperCase(),
      quantity: risk.quantity,
      price: config.entryMode === "limit" ? plan.entry : null,
      notional: risk.notional,
      leverage: risk.leverage
    });
    if (!validation.ok) throw new Error(validation.reason ?? "SYMBOL_RULE_VALIDATION_FAILED");
    const availableBalance = await this.options.loadAvailableBalance();
    if (availableBalance === null) throw new Error("BINANCE_DISCONNECTED");
    if (risk.margin > availableBalance) throw new Error("INSUFFICIENT_AVAILABLE_BALANCE");

    const setupKey = buildSetupKey(this.options.tradingAccountId, plan, risk);
    const status: RealExecutionProposalStatus = config.realExecutionMode === "DRY_RUN" ? "DRY_RUN" : "PENDING";
    const normalizedEntryPrice = config.entryMode === "limit" ? validation.normalized.price ?? normalizePrice(plan.entry, rules.tickSize) : null;
    const proposalBase = {
      id: deterministicUuid(`${this.options.tradingAccountId}:${setupKey}:real-proposal`),
      tradingAccountId: this.options.tradingAccountId,
      setupKey,
      symbol: risk.symbol,
      direction: plan.direction,
      status,
      requestedEntryType: config.entryMode,
      requestedEntryPrice: plan.entry,
      normalizedEntryPrice,
      requestedQuantity: risk.quantity,
      normalizedQuantity: validation.normalized.quantity,
      requestedStopLoss: plan.stopLoss,
      normalizedStopLoss: normalizePrice(plan.stopLoss, rules.tickSize),
      requestedTakeProfit: plan.takeProfit,
      normalizedTakeProfit: normalizePrice(plan.takeProfit, rules.tickSize),
      estimatedNotional: risk.notional,
      estimatedMargin: risk.margin,
      configuredLeverage: risk.leverage,
      configuredMarginMode: config.marginMode,
      symbolTickSize: rules.tickSize,
      symbolStepSize: rules.stepSize,
      symbolMinQty: rules.minQty,
      symbolMinNotional: rules.minNotional,
      strategySnapshot: {
        entryMode: config.entryMode,
        realExecutionMode: config.realExecutionMode,
        takeProfitRule: "HTF_LIQUIDITY",
        minimumRiskReward: config.minimumRiskReward
      },
      riskSnapshot: { ...risk },
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
    } satisfies Omit<CreateRealExecutionProposalInput, "proposalHash">;
    const proposalHash = fingerprintProposal(proposalBase);
    const { proposal, created } = await this.options.proposalRepository.createOrGet({ ...proposalBase, proposalHash });
    if (created) {
      const type = status === "DRY_RUN" ? "REAL_DRY_RUN_CREATED" : "REAL_PROPOSAL_CREATED";
      await this.audit(type, proposal, { setupKey, status });
    }
    this.options.logger.warn("REAL execution proposal created; no Mainnet order was sent", {
      tradingAccountId: this.options.tradingAccountId,
      proposalId: proposal.id,
      status: proposal.status
    });
    throw new Error(status === "DRY_RUN" ? "REAL_DRY_RUN_CREATED" : "APPROVAL_REQUIRED");
  }

  private assertGate(config: AppConfig): void {
    if (config.killSwitch) throw new Error("KILL_SWITCH");
    if (!config.tradingEnabled) throw new Error("TRADING_DISABLED");
    if (!this.options.runtimeReady()) throw new Error("RUNTIME_NOT_READY");
    if (!this.options.binanceConnected()) throw new Error("BINANCE_DISCONNECTED");
    if (!this.options.reconciliationHealthy()) throw new Error("RECONCILIATION_REQUIRED");
    if (config.realExecutionMode === "LOCKED") throw new Error("REAL_EXECUTION_MODE_LOCKED");
  }

  private async audit(type: string, proposal: RealExecutionProposal, metadata: Record<string, unknown>): Promise<void> {
    await this.options.auditRepository.saveAuditEvent({
      id: crypto.randomUUID(),
      tradingAccountId: proposal.tradingAccountId,
      executionIntentId: null,
      symbol: proposal.symbol,
      type,
      metadata: { ...metadata, proposalId: proposal.id },
      createdAt: new Date().toISOString()
    });
  }
}

function deterministicUuid(input: string): string {
  const hex = crypto.createHash("sha256").update(input).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}
