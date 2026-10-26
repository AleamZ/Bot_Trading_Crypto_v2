import crypto from "node:crypto";
import type { AppConfig } from "../config/AppConfig.js";
import type { TradingEngine } from "../engine/TradingEngine.js";
import type { ExecutionGateway } from "../ports/ExecutionGateway.js";
import type { DecisionLogger } from "../ports/Logger.js";
import type { ExecutionIntentRepository } from "../execution/ExecutionIntentRepository.js";
import { buildSetupKey } from "../execution/ExecutionIntent.js";
import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { Direction } from "../../domain/trade/Direction.js";
import { buildAiDecisionMessages, buildBotAnalysisSnapshot, type BotAnalysisSnapshot } from "./BotAnalysisSkill.js";
import { extractJsonObject, LlmRequestError, type LlmClient } from "./LocalLlmClient.js";
import type { AiCallGate } from "./AiCallGate.js";

export const AI_DECISION_AUDIT_TYPE = "AI_DECISION";
/** Setups below this evidence count are not worth a model call unless already ReadyToEnter. */
export const AI_MIN_EVIDENCE = 5;

export type AiTradingMode = AppConfig["aiTradingMode"];

export interface AiDecision {
  action: "ENTER" | "SKIP";
  symbol: string;
  direction: Direction | null;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  reason: string;
}

export type AiRejectCode =
  | "SYMBOL_MISMATCH"
  | "DIRECTION_MISMATCH"
  | "INVALID_PRICE"
  | "INVALID_PROTECTION_SIDE"
  | "LIVE_PRICE_UNAVAILABLE"
  | "PRICE_OUTSIDE_SL_TP"
  | "RR_BELOW_MINIMUM"
  | "INVALID_CONFIDENCE"
  | "LOW_CONFIDENCE"
  | "SL_TIGHTER_THAN_STRUCTURE";

export type AiDecisionValidation =
  | { ok: true; plan: EntryPlan; riskReward: number }
  | { ok: false; code: AiRejectCode; reason: string };

export type AiDecisionOutcome = "SKIPPED" | "REJECTED" | "ADVISORY" | "SUBMITTED" | "EXECUTION_FAILED" | "LLM_ERROR";

export interface AiDecisionRecord {
  configuredMode: AiTradingMode;
  /** AUTO falls back to ADVISORY on REAL accounts. */
  effectiveMode: Exclude<AiTradingMode, "OFF">;
  accountMode: "DEMO" | "REAL";
  model: string;
  symbol: string;
  m5CloseTime: number;
  setupState: string;
  evidence: number;
  livePrice: number | null;
  decision: AiDecision | null;
  rawResponse: string | null;
  outcome: AiDecisionOutcome;
  accepted: boolean;
  rejectCode: string | null;
  rejectReason: string | null;
  riskReward: number | null;
  executionIntentId: string | null;
  latencyMs: number;
}

/** Why the advisor did not ask the model on a scan. */
export type AiScreenSkip = "IN_FLIGHT" | "ALREADY_CONSULTED" | "HAS_POSITION" | "SETUP_ARCHIVED" | "TREND_NEUTRAL" | "LOW_EVIDENCE";

type AiStepBody =
  | { stage: "screen"; skip: AiScreenSkip; setupState: string; evidence: number; trend: string }
  | { stage: "analyze"; model: string; mode: "AUTO" | "ADVISORY"; setupState: string; evidence: number; trend: string; livePrice: number | null; queuedMs: number }
  | { stage: "answer"; latencyMs: number; decision: AiDecision }
  | { stage: "check"; gate: "rules" | "duplicate" | "risk"; ok: boolean; code: string | null; reason: string | null; riskReward: number | null }
  | { stage: "result"; outcome: AiDecisionOutcome; rejectCode: string | null; rejectReason: string | null; executionIntentId: string | null; latencyMs: number };

/** One observable step of the advisor (what it checked, asked, got back and decided), for the live dashboard. */
export type AiProgressStep = { id: string; symbol: string; at: number } & AiStepBody;

/** What the scanner hands the advisor for one symbol after it processed that symbol's candles. */
export interface AiScanContext {
  symbol: string;
  engine: TradingEngine;
  /** Close time of the latest closed M5 candle the engine has processed. */
  m5CloseTime: number;
  /** Current symbol-scoped config; read again after the model answers. */
  config(): AppConfig;
  livePrice(): Promise<number | null>;
  /** Scanner-level ownership: an open Binance position or a resting bot entry on this symbol. */
  hasActiveEntry(): boolean;
  accountOpenPositions(): number;
  /** Called after an AI order was accepted so the engine stops taking setups on this symbol. */
  markEntryPlaced(): void;
}

/** Scanner hook. Never throws and never blocks the scan. */
export interface AiScanHook {
  onScan(context: AiScanContext): void;
  whenIdle(): Promise<void>;
}

export interface AiTradeAdvisorOptions {
  tradingAccountId: string;
  accountMode: "DEMO" | "REAL";
  llm: LlmClient;
  defaultModel: string;
  /** Audit trail (AI_DECISION events) and the open-intent duplicate check. */
  repository: ExecutionIntentRepository;
  /** The same gateway the engine submits through (ExecutionCoordinator on DEMO). */
  execution: ExecutionGateway;
  logger: DecisionLogger;
  now?: () => number;
  /** Receives every step as it happens; must not throw (errors are logged and ignored). */
  onProgress?: (step: AiProgressStep) => void;
  /** Shared spacing between model calls (all symbols and accounts); absent = no spacing. */
  callGate?: AiCallGate;
}

/**
 * Asks a local LLM whether the bot should enter, at most once per symbol per closed M5 candle.
 * The model output is untrusted: it is validated against the strategy invariants and then goes
 * through the engine's own risk manager and execution gateway, with no separate bypasses.
 */
export class AiTradeAdvisor implements AiScanHook {
  private readonly consultedCandle = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly options: AiTradeAdvisorOptions) {
    this.now = options.now ?? Date.now;
  }

  onScan(context: AiScanContext): void {
    try {
      const skip = this.screen(context);
      if (skip === "AI_OFF") return;
      if (skip) {
        const diagnostic = context.engine.getSetupDiagnostic();
        this.progress(context.symbol, { stage: "screen", skip, setupState: diagnostic.state, evidence: diagnostic.evidenceCount, trend: diagnostic.trend });
        return;
      }
      this.consultedCandle.set(context.symbol, context.m5CloseTime);
      const task = this.consult(context)
        .catch((error: unknown) => {
          this.options.logger.warn("[AI] advisor failed", { symbol: context.symbol, error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          if (this.inFlight.get(context.symbol) === task) this.inFlight.delete(context.symbol);
        });
      this.inFlight.set(context.symbol, task);
    } catch (error) {
      this.options.logger.warn("[AI] advisor hook failed", { symbol: context.symbol, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
  }

  /** null = ask the model now; otherwise why not ("AI_OFF" is silent). */
  private screen(context: AiScanContext): AiScreenSkip | "AI_OFF" | null {
    if (context.config().aiTradingMode === "OFF") return "AI_OFF";
    if (this.inFlight.has(context.symbol)) return "IN_FLIGHT";
    if (this.consultedCandle.get(context.symbol) === context.m5CloseTime) return "ALREADY_CONSULTED";
    if (context.engine.getState().openPositions > 0 || context.hasActiveEntry()) return "HAS_POSITION";
    return setupSkipReason(context.engine.getSetupDiagnostic());
  }

  private progress(symbol: string, body: AiStepBody): void {
    if (!this.options.onProgress) return;
    try {
      this.options.onProgress({ id: crypto.randomUUID(), symbol, at: this.now(), ...body });
    } catch (error) {
      this.options.logger.warn("[AI] progress listener failed", { symbol, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async consult(context: AiScanContext): Promise<void> {
    const queuedMs = this.options.callGate ? await this.options.callGate.acquire() : 0;
    if (queuedMs > 0) {
      // The setup may have moved on while this call waited for its turn.
      if (context.config().aiTradingMode === "OFF") return;
      const skip = context.engine.getState().openPositions > 0 || context.hasActiveEntry() ? "HAS_POSITION" : setupSkipReason(context.engine.getSetupDiagnostic());
      if (skip) {
        const current = context.engine.getSetupDiagnostic();
        this.progress(context.symbol, { stage: "screen", skip, setupState: current.state, evidence: current.evidenceCount, trend: current.trend });
        return;
      }
    }
    const startedAt = this.now();
    const config = context.config();
    const diagnostic = context.engine.getSetupDiagnostic();
    const state = context.engine.getState();
    const model = config.aiModel.trim() || this.options.defaultModel;
    const effectiveMode = config.aiTradingMode === "AUTO" && this.options.accountMode === "DEMO" ? "AUTO" : "ADVISORY";
    const lastM5Close = state.m5Candles[state.m5Candles.length - 1]?.close ?? null;
    const snapshot: BotAnalysisSnapshot = buildBotAnalysisSnapshot({
      diagnostic,
      config,
      livePrice: (await this.readLivePrice(context)) ?? lastM5Close,
      h1Candles: state.h1Candles,
      m5Candles: state.m5Candles,
      accountOpenPositions: context.accountOpenPositions(),
      symbolOpenPositions: state.openPositions,
      at: startedAt
    });
    const record: AiDecisionRecord = {
      configuredMode: config.aiTradingMode,
      effectiveMode,
      accountMode: this.options.accountMode,
      model,
      symbol: context.symbol,
      m5CloseTime: context.m5CloseTime,
      setupState: diagnostic.state,
      evidence: diagnostic.evidenceCount,
      livePrice: snapshot.livePrice,
      decision: null,
      rawResponse: null,
      outcome: "LLM_ERROR",
      accepted: false,
      rejectCode: null,
      rejectReason: null,
      riskReward: null,
      executionIntentId: null,
      latencyMs: 0
    };
    const finish = async (patch: Partial<AiDecisionRecord>): Promise<void> => {
      Object.assign(record, patch, { latencyMs: this.now() - startedAt });
      await this.saveDecision(record);
      this.progress(context.symbol, {
        stage: "result",
        outcome: record.outcome,
        rejectCode: record.rejectCode,
        rejectReason: record.rejectReason,
        executionIntentId: record.executionIntentId,
        latencyMs: record.latencyMs
      });
    };
    this.progress(context.symbol, {
      stage: "analyze",
      model,
      mode: effectiveMode,
      setupState: diagnostic.state,
      evidence: diagnostic.evidenceCount,
      trend: diagnostic.trend,
      livePrice: snapshot.livePrice,
      queuedMs
    });

    let content: string;
    try {
      const response = await this.options.llm.complete({ model, messages: buildAiDecisionMessages(snapshot), jsonMode: true, temperature: 0 });
      record.model = response.model;
      content = response.content;
    } catch (error) {
      const code = error instanceof LlmRequestError ? error.code : "LLM_ERROR";
      this.options.logger.warn("[AI] model call failed", { symbol: context.symbol, code, error: error instanceof Error ? error.message : String(error) });
      await finish({ outcome: "LLM_ERROR", rejectCode: code, rejectReason: error instanceof Error ? error.message : String(error) });
      return;
    }

    const decision = parseAiDecision(extractJsonObject(content));
    if (!decision) {
      this.options.logger.warn("[AI] model returned no valid decision JSON", { symbol: context.symbol });
      await finish({ outcome: "LLM_ERROR", rawResponse: content.slice(0, 2000), rejectCode: "INVALID_JSON", rejectReason: "Model output is not a valid decision object" });
      return;
    }
    record.decision = decision;
    this.progress(context.symbol, { stage: "answer", latencyMs: this.now() - startedAt, decision });
    if (decision.action === "SKIP") {
      await finish({ outcome: "SKIPPED", rejectReason: decision.reason || null });
      return;
    }

    // The model may have taken seconds: validate against the state and price as they are now.
    const current = context.engine.getSetupDiagnostic();
    const currentConfig = context.config();
    const livePrice = (await this.readLivePrice(context)) ?? snapshot.livePrice;
    record.livePrice = livePrice;
    const validation = validateAiDecision(decision, {
      symbol: context.symbol,
      trend: current.trend,
      livePrice,
      plan: current.state === "Archived" ? null : current.entryPlan,
      minimumRiskReward: currentConfig.minimumRiskReward,
      aiMinConfidence: currentConfig.aiMinConfidence,
      entryMode: currentConfig.entryMode
    });
    this.progress(context.symbol, {
      stage: "check",
      gate: "rules",
      ok: validation.ok,
      code: validation.ok ? null : validation.code,
      reason: validation.ok ? null : validation.reason,
      riskReward: validation.ok ? validation.riskReward : null
    });
    if (!validation.ok) {
      await finish({ outcome: "REJECTED", rejectCode: validation.code, rejectReason: validation.reason });
      return;
    }
    record.accepted = true;
    record.riskReward = validation.riskReward;

    if (currentConfig.aiTradingMode !== "AUTO" || this.options.accountMode !== "DEMO") {
      const locked = currentConfig.aiTradingMode === "AUTO" && this.options.accountMode !== "DEMO";
      await finish({
        outcome: "ADVISORY",
        effectiveMode: "ADVISORY",
        rejectCode: locked ? "REAL_EXECUTION_LOCKED" : null,
        rejectReason: locked ? "AUTO trading is DEMO-only; decision recorded as advisory" : null
      });
      return;
    }

    const duplicate = await this.duplicateEntryReason(context);
    this.progress(context.symbol, { stage: "check", gate: "duplicate", ok: !duplicate, code: duplicate ? "DUPLICATE_ENTRY_GUARD" : null, reason: duplicate, riskReward: null });
    if (duplicate) {
      await finish({ outcome: "REJECTED", accepted: false, rejectCode: "DUPLICATE_ENTRY_GUARD", rejectReason: duplicate });
      return;
    }

    const risk = await context.engine.assessRisk(validation.plan, this.now());
    this.progress(context.symbol, {
      stage: "check",
      gate: "risk",
      ok: risk.accepted,
      code: risk.accepted ? null : `RISK_${risk.rejectCode ?? "REJECTED"}`,
      reason: risk.accepted ? null : risk.reason,
      riskReward: validation.riskReward
    });
    if (!risk.accepted) {
      await finish({ outcome: "REJECTED", accepted: false, rejectCode: `RISK_${risk.rejectCode ?? "REJECTED"}`, rejectReason: risk.reason });
      return;
    }

    try {
      await this.options.execution.submitBracketOrder(validation.plan, risk);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.warn("[AI] order submission failed", { symbol: context.symbol, error: message });
      await finish({ outcome: "EXECUTION_FAILED", rejectCode: "EXECUTION_FAILED", rejectReason: message, executionIntentId: await this.findIntentId(validation.plan, risk) });
      return;
    }
    context.markEntryPlaced();
    const executionIntentId = await this.findIntentId(validation.plan, risk);
    this.options.logger.info("[AI] order submitted", { symbol: context.symbol, executionIntentId, direction: validation.plan.direction });
    await finish({ outcome: "SUBMITTED", executionIntentId });
  }

  private async duplicateEntryReason(context: AiScanContext): Promise<string | null> {
    if (context.engine.getState().openPositions > 0) return "The engine already owns a position or entry on this symbol";
    if (context.hasActiveEntry()) return "Symbol has an open position or resting bot entry";
    const open = await this.options.repository.listOpenByAccount(this.options.tradingAccountId);
    if (open.some((intent) => intent.symbol === context.symbol)) return "Symbol has an open execution intent";
    return null;
  }

  private async findIntentId(plan: EntryPlan, risk: Parameters<ExecutionGateway["submitBracketOrder"]>[1]): Promise<string | null> {
    try {
      const intent = await this.options.repository.findBySetupKey(this.options.tradingAccountId, buildSetupKey(this.options.tradingAccountId, plan, risk));
      return intent?.id ?? null;
    } catch {
      return null;
    }
  }

  private async readLivePrice(context: AiScanContext): Promise<number | null> {
    try {
      const price = await context.livePrice();
      return price !== null && Number.isFinite(price) && price > 0 ? price : null;
    } catch {
      return null;
    }
  }

  private async saveDecision(record: AiDecisionRecord): Promise<void> {
    try {
      await this.options.repository.saveAuditEvent({
        id: crypto.randomUUID(),
        tradingAccountId: this.options.tradingAccountId,
        executionIntentId: record.executionIntentId,
        symbol: record.symbol,
        type: AI_DECISION_AUDIT_TYPE,
        metadata: { ...record },
        createdAt: new Date(this.now()).toISOString()
      });
    } catch (error) {
      this.options.logger.warn("[AI] decision audit failed", { symbol: record.symbol, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export function isEligibleSetup(diagnostic: ReturnType<TradingEngine["getSetupDiagnostic"]>): boolean {
  return setupSkipReason(diagnostic) === null;
}

function setupSkipReason(diagnostic: ReturnType<TradingEngine["getSetupDiagnostic"]>): AiScreenSkip | null {
  if (diagnostic.state === "Archived") return "SETUP_ARCHIVED";
  if (diagnostic.trend === "neutral") return "TREND_NEUTRAL";
  return diagnostic.state === "ReadyToEnter" || diagnostic.evidenceCount >= AI_MIN_EVIDENCE ? null : "LOW_EVIDENCE";
}

/** Normalizes the model's JSON. Returns null when there is no usable action at all. */
export function parseAiDecision(raw: Record<string, unknown> | null): AiDecision | null {
  if (!raw) return null;
  const action = typeof raw.action === "string" ? raw.action.trim().toUpperCase() : "";
  if (action !== "ENTER" && action !== "SKIP") return null;
  const direction = typeof raw.direction === "string" ? raw.direction.trim().toLowerCase() : "";
  return {
    action,
    symbol: typeof raw.symbol === "string" ? raw.symbol.trim().toUpperCase() : "",
    direction: direction === "bullish" || direction === "bearish" ? direction : null,
    entry: toNumber(raw.entry),
    stopLoss: toNumber(raw.stopLoss),
    takeProfit: toNumber(raw.takeProfit),
    confidence: toNumber(raw.confidence),
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 400) : ""
  };
}

/**
 * Checks an ENTER decision against the strategy invariants and turns it into the executable plan.
 * Mirrors the engine: a MARKET entry (or a LIMIT price already crossed) fills at the live price,
 * so RR is measured from there.
 */
export function validateAiDecision(
  decision: AiDecision,
  input: {
    symbol: string;
    trend: Direction | "neutral";
    livePrice: number | null;
    plan: EntryPlan | null;
    minimumRiskReward: number;
    aiMinConfidence: number;
    entryMode: AppConfig["entryMode"];
  }
): AiDecisionValidation {
  if (decision.symbol !== input.symbol) return reject("SYMBOL_MISMATCH", `Decision symbol ${decision.symbol || "-"} is not ${input.symbol}`);
  if (input.trend === "neutral" || decision.direction !== input.trend) {
    return reject("DIRECTION_MISMATCH", `Direction ${decision.direction ?? "-"} does not match H1 trend ${input.trend}`);
  }
  const direction = input.trend;
  const { entry, stopLoss, takeProfit } = decision;
  if (![entry, stopLoss, takeProfit].every((value) => Number.isFinite(value) && value > 0)) {
    return reject("INVALID_PRICE", "Entry, stop loss and take profit must be finite and > 0");
  }
  const bullish = direction === "bullish";
  if (bullish ? !(stopLoss < entry && takeProfit > entry) : !(stopLoss > entry && takeProfit < entry)) {
    return reject("INVALID_PROTECTION_SIDE", bullish ? "Long needs stop loss below and take profit above entry" : "Short needs stop loss above and take profit below entry");
  }
  const live = input.livePrice;
  if (live === null || !Number.isFinite(live) || live <= 0) return reject("LIVE_PRICE_UNAVAILABLE", "Live price is unavailable");
  if (bullish ? !(live > stopLoss && live < takeProfit) : !(live < stopLoss && live > takeProfit)) {
    return reject("PRICE_OUTSIDE_SL_TP", `Live price ${live} is not strictly between SL ${stopLoss} and TP ${takeProfit}`);
  }
  const crossed = bullish ? live < entry : live > entry;
  const executionEntry = input.entryMode === "market" || crossed ? live : entry;
  const riskReward = Math.abs(takeProfit - executionEntry) / Math.abs(executionEntry - stopLoss);
  if (!Number.isFinite(riskReward) || riskReward < input.minimumRiskReward) {
    return reject("RR_BELOW_MINIMUM", `RR ${Number.isFinite(riskReward) ? riskReward.toFixed(2) : "-"} is below minimum ${input.minimumRiskReward}`);
  }
  if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    return reject("INVALID_CONFIDENCE", "Confidence must be a number between 0 and 1");
  }
  if (decision.confidence < input.aiMinConfidence) {
    return reject("LOW_CONFIDENCE", `Confidence ${decision.confidence} is below ${input.aiMinConfidence}`);
  }
  const plan = input.plan && input.plan.direction === direction ? input.plan : null;
  if (plan && (bullish ? stopLoss > plan.stopLoss : stopLoss < plan.stopLoss)) {
    return reject("SL_TIGHTER_THAN_STRUCTURE", `Stop loss ${stopLoss} is tighter than the cluster stop ${plan.stopLoss}`);
  }

  const structuralStopBoundary = plan?.structuralStopBoundary ?? stopLoss;
  const executionPlan: EntryPlan = {
    direction,
    entry: executionEntry,
    structuralStopBoundary,
    stopLossBuffer: Math.abs(structuralStopBoundary - stopLoss),
    stopLoss,
    takeProfit,
    riskReward,
    reason: `AI decision: ${decision.reason}`.slice(0, 500),
    origin: "AI"
  };
  if (plan?.triggeringFvgId) executionPlan.triggeringFvgId = plan.triggeringFvgId;
  if (plan?.protectiveClusterFvgIds) executionPlan.protectiveClusterFvgIds = plan.protectiveClusterFvgIds;
  return { ok: true, plan: executionPlan, riskReward };
}

function reject(code: AiRejectCode, reason: string): AiDecisionValidation {
  return { ok: false, code, reason };
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}
