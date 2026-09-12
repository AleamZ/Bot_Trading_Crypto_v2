import type { AppConfig } from "../config/AppConfig.js";
import type { ExecutionGateway } from "../ports/ExecutionGateway.js";
import type { DecisionLogger } from "../ports/Logger.js";
import type { TradingRepository } from "../ports/Repositories.js";
import { EventBus } from "./EventBus.js";
import type { Candle } from "../../domain/market-data/Candle.js";
import type { Direction } from "../../domain/trade/Direction.js";
import { detectH1Trend } from "../../domain/trend/TrendDetector.js";
import type { Fvg } from "../../domain/fvg/Fvg.js";
import { detectFvgs, detectLatestLtfFvg, isFvgInvalidated, isFvgTouched, reconstructFvgLifecycle } from "../../domain/fvg/FvgDetector.js";
import type { MarketStructureSignal } from "../../domain/market-structure/MarketStructureSignal.js";
import { detectM5StructureSignal } from "../../domain/market-structure/StructureDetector.js";
import { buildLiquidityState, selectExternalLiquidityTarget } from "../../domain/liquidity/LiquidityDetector.js";
import { calculateEntryPlan, calculateFirstTouchEntry, type EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";
import { evaluateRisk } from "../../domain/risk/RiskManager.js";
import { transitionSetupState, type SetupState } from "../../domain/setup/SetupStateMachine.js";
import type { FuturesSymbolRules } from "../../domain/symbol/SymbolRules.js";

export interface EngineState {
  setupState: SetupState;
  trend: Direction | "neutral";
  balance: number;
  h1Candles: Candle[];
  m5Candles: Candle[];
  openPositions: number;
  accountOpenPositions: number;
  drawdownPercent: number;
  pendingSignal: MarketStructureSignal | null;
  pendingLtfFvg: Fvg | null;
  activeLtfFvgCluster: Fvg[];
  frozenProtectiveCluster: Fvg[];
  pendingEntryPlan: EntryPlan | null;
  activeRisk: RiskDecision | null;
  setupEvidence: SetupEvidence;
}

export type AvailableBalanceProvider = () => Promise<number | null>;
export type CurrentUsedMarginProvider = () => Promise<number | null>;
export type SymbolRulesProvider = (symbol: string) => Promise<FuturesSymbolRules>;

export type FunnelSource = "LIVE_SCAN" | "BOOTSTRAP_REPLAY" | "RECONCILIATION" | "HISTORICAL";
export type FunnelStage =
  | "SCAN_EVALUATED"
  | "HTF_TREND_STATE_VALID"
  | "HTF_TREND_STATE_NEUTRAL"
  | "HTF_TREND_STATE_UNKNOWN"
  | "HTF_TREND_STATE_BULLISH"
  | "HTF_TREND_STATE_BEARISH"
  | "HTF_NEW_CANDLE_TREND_VALID"
  | "HTF_NEW_CANDLE_TREND_NEUTRAL"
  | "HTF_FVG_RAW_DETECTED"
  | "HTF_FVG_DIRECTION_MATCH"
  | "HTF_FVG_UNMITIGATED_ELIGIBLE"
  | "HTF_FVG_SELECTED"
  | "WAITING_HTF_FIRST_TOUCH"
  | "HTF_FIRST_TOUCH_CONFIRMED"
  | "MONITORING_LTF"
  | "BOS_CONFIRMED"
  | "CHOCH_CONFIRMED"
  | "LTF_FVG_RAW_DETECTED"
  | "LTF_FVG_POST_STRUCTURE"
  | "LTF_FVG_DIRECTION_MATCH"
  | "LTF_FVG_FRESH"
  | "LTF_FVG_ALREADY_TOUCHED"
  | "LTF_FVG_INVALIDATED"
  | "LTF_FVG_SELECTED"
  | "WAITING_LTF_FIRST_TOUCH"
  | "LTF_FIRST_TOUCH_CONFIRMED"
  | "ENTRY_PLAN_CREATED"
  | "ENTRY_PLAN_REJECTED"
  | "RR_GATE_REACHED"
  | "RR_GATE_PASSED"
  | "RR_GATE_REJECTED"
  | "RISK_MANAGER_REACHED"
  | "RISK_PASSED"
  | "RISK_REJECTED";

export interface FunnelTelemetryEvent {
  stage: FunnelStage;
  accountId: string;
  runtimeId?: string;
  symbol: string;
  timeframe: "H1" | "M5" | "ACCOUNT";
  setupId?: string | null;
  timestamp: number;
  source: FunnelSource;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface FunnelTelemetryContext {
  accountId: string;
  runtimeId?: string;
  sink?: (event: FunnelTelemetryEvent) => void;
}

export type FunnelMetrics = {
  counters: Partial<Record<FunnelStage, number>>;
  countersBySource: Partial<Record<FunnelSource, Partial<Record<FunnelStage, number>>>>;
  stateEnteredAt: Partial<Record<SetupState, number>>;
  stateAgeMs: Partial<Record<SetupState, number>>;
  candidateEnteredAt: number | null;
  candidateAgeMs: number | null;
  lastEventAt: number | null;
};

export type PlanNullReason =
  | "NO_ELIGIBLE_TP_LIQUIDITY"
  | "INVALID_RR_INPUTS"
  | "INVALID_SL_GEOMETRY"
  | "INVALID_PRICE_ORDERING"
  | "MISSING_SYMBOL_METADATA"
  | "STALE_FVG"
  | "ALREADY_TOUCHED_FVG"
  | "INVALIDATED_STRUCTURE";

const terminalRiskRejectCodes = new Set<NonNullable<RiskDecision["rejectCode"]>>([
  "INVALID_PRICE",
  "INVALID_QUANTITY",
  "MIN_QTY",
  "MAX_QTY",
  "MIN_NOTIONAL",
  "RR_BELOW_MINIMUM",
  "REQUIRED_LEVERAGE_EXCEEDS_MAX"
]);

export interface SetupEvidence {
  htfFvg: Fvg | null;
  htfFirstTouchedAt: number | null;
  ltfSignal: MarketStructureSignal | null;
  ltfFvg: Fvg | null;
  ltfFirstTouchedAt: number | null;
  activeLtfFvgCluster: Fvg[];
  frozenProtectiveCluster: Fvg[];
  entryPlan: EntryPlan | null;
}

export interface SetupDiagnostic {
  symbol: string;
  state: SetupState;
  setupKey: string | null;
  trend: Direction | "neutral";
  htfFvg: (Fvg & { mitigatedAt: number | null }) | null;
  ltfSignal: MarketStructureSignal | null;
  ltfFvg: (Fvg & { mitigatedAt: number | null }) | null;
  activeLtfFvgCluster: Fvg[];
  frozenProtectiveCluster: Fvg[];
  entryPlan: EntryPlan | null;
  evidenceCount: number;
  invariantOk: boolean;
}

export class TradingEngine {
  readonly events: EventBus;
  private state: EngineState;

  constructor(
    private config: AppConfig,
    private readonly repository: TradingRepository,
    private readonly execution: ExecutionGateway,
    private readonly logger: DecisionLogger,
    private readonly availableBalanceProvider: AvailableBalanceProvider | null = null,
    private readonly symbolRulesProvider: SymbolRulesProvider | null = null,
    private readonly currentUsedMarginProvider: CurrentUsedMarginProvider | null = null,
    initialBalance = 10_000,
    private readonly funnelContext: FunnelTelemetryContext = { accountId: "unknown" }
  ) {
    this.events = new EventBus(repository, logger);
    this.state = {
      setupState: "WaitingTrend",
      trend: "neutral",
      balance: initialBalance,
      h1Candles: [],
      m5Candles: [],
      openPositions: 0,
      accountOpenPositions: 0,
      drawdownPercent: 0,
      pendingSignal: null,
      pendingLtfFvg: null,
      activeLtfFvgCluster: [],
      frozenProtectiveCluster: [],
      pendingEntryPlan: null,
      activeRisk: null,
      setupEvidence: emptySetupEvidence()
    };
  }

  private readonly funnelCounters: Partial<Record<FunnelStage, number>> = {};
  private readonly funnelCountersBySource: Partial<Record<FunnelSource, Partial<Record<FunnelStage, number>>>> = {};
  private readonly stateEnteredAt: Partial<Record<SetupState, number>> = { WaitingTrend: Date.now() };
  private candidateEnteredAt: number | null = null;
  private lastFunnelEventAt: number | null = null;
  private htfTrendEstablished = false;

  getFunnelMetrics(): FunnelMetrics {
    const now = Date.now();
    return {
      counters: { ...this.funnelCounters },
      countersBySource: Object.fromEntries(Object.entries(this.funnelCountersBySource).map(([source, counters]) => [source, { ...counters }])),
      stateEnteredAt: { ...this.stateEnteredAt },
      stateAgeMs: Object.fromEntries(Object.entries(this.stateEnteredAt).map(([state, enteredAt]) => [state, now - (enteredAt ?? now)])),
      candidateEnteredAt: this.candidateEnteredAt,
      candidateAgeMs: this.candidateEnteredAt === null ? null : now - this.candidateEnteredAt,
      lastEventAt: this.lastFunnelEventAt
    };
  }

  recordScan(source: FunnelSource = "LIVE_SCAN"): void {
    this.emitFunnel("SCAN_EVALUATED", "ACCOUNT", source);
    if (this.state.trend === "bullish" || this.state.trend === "bearish") {
      this.emitFunnel("HTF_TREND_STATE_VALID", "ACCOUNT", source, undefined, undefined, { direction: this.state.trend });
      this.emitFunnel(this.state.trend === "bullish" ? "HTF_TREND_STATE_BULLISH" : "HTF_TREND_STATE_BEARISH", "ACCOUNT", source);
    } else {
      this.emitFunnel(this.htfTrendEstablished ? "HTF_TREND_STATE_NEUTRAL" : "HTF_TREND_STATE_UNKNOWN", "ACCOUNT", source);
    }
  }

  getState(): Readonly<EngineState> {
    return this.state;
  }

  syncActivePosition(position: { side: "long" | "short"; quantity: number; entryPrice: number; unrealizedProfit: number; stopLoss: number | null; takeProfit: number | null } | null, accountOpenPositions = position ? 1 : 0): void {
    this.state.accountOpenPositions = accountOpenPositions;
    if (!position || position.quantity <= 0) {
      if (this.state.openPositions > 0) {
        this.state.openPositions = 0;
        this.state.setupState = "WaitingTrend";
        this.state.pendingSignal = null;
        this.state.pendingLtfFvg = null;
        this.state.activeLtfFvgCluster = [];
        this.state.frozenProtectiveCluster = [];
        this.state.pendingEntryPlan = null;
        this.state.activeRisk = null;
        this.state.setupEvidence = emptySetupEvidence();
      }
      return;
    }

    this.state.openPositions = 1;
    this.state.setupState = this.state.setupState === "PositionOpened" ? "ManagingTrade" : "PositionOpened";
    this.state.pendingSignal = null;
    this.state.pendingLtfFvg = null;
    this.state.activeLtfFvgCluster = [];
    this.state.frozenProtectiveCluster = [];
    this.state.pendingEntryPlan = null;
    this.state.setupEvidence = emptySetupEvidence();
    this.state.trend = position.side === "long" ? "bullish" : "bearish";
    this.state.activeRisk = {
      accepted: true,
      reason: "Active Binance position",
      symbol: this.config.symbol,
      margin: 0,
      leverage: 0,
      requiredLeverage: 0,
      leverageNeededForMargin: 0,
      effectiveMaxLeverage: this.config.maxLeverage,
      selectedLeverage: 0,
      requiredMargin: 0,
      maxLeverage: this.config.maxLeverage,
      maxMarginUsagePercent: this.config.maxMarginUsagePercent,
      maxTotalMarginUsagePercent: this.config.maxTotalMarginUsagePercent,
      currentUsedMargin: 0,
      marginMode: this.config.marginMode,
      liquidationSafetyBufferPercent: this.config.liquidationSafetyBufferPercent,
      positionSize: position.entryPrice * position.quantity,
      quantity: position.quantity,
      notional: position.entryPrice * position.quantity,
      entry: position.entryPrice,
      stopLoss: position.stopLoss ?? position.entryPrice,
      takeProfit: position.takeProfit ?? position.entryPrice,
      estimatedLoss: 0,
      estimatedProfit: position.unrealizedProfit,
      actualRiskUsdt: 0,
      targetRiskUsdt: this.config.riskPerTradeUsdt,
      riskPerTradeUsdt: this.config.riskPerTradeUsdt,
      availableBalance: this.state.balance,
      maxAllowedMargin: 0,
      marginUsagePercent: 0,
      candidateRequiredMargin: 0,
      projectedTotalMargin: 0,
      totalMarginUsagePercent: 0,
      maintenanceMarginRate: null,
      maintenanceMarginAmount: null,
      maintenanceMarginBracket: null,
      estimatedLiquidationPrice: null,
      distanceSlToLiquidation: null,
      liquidationSafetyStatus: "UNAVAILABLE",
      riskReward: 0,
      createdAt: Date.now()
    };
  }

  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  getDashboardState(): unknown {
    return {
      setupState: this.state.setupState,
      trend: this.state.trend,
      balance: this.state.balance,
      candleCounts: {
        H1: this.state.h1Candles.length,
        M5: this.state.m5Candles.length
      },
      pendingSetup:
        this.state.pendingEntryPlan && this.state.pendingLtfFvg
          ? {
              signal: this.state.pendingSignal,
              fvg: this.state.pendingLtfFvg,
              cluster: this.state.frozenProtectiveCluster.length > 0 ? this.state.frozenProtectiveCluster : this.state.activeLtfFvgCluster,
              plan: this.state.pendingEntryPlan
            }
          : null,
      activeRisk: this.state.activeRisk
    };
  }

  getSetupDiagnostic(): SetupDiagnostic {
    const evidence = this.state.setupEvidence;
    const setupKey = [
      this.config.symbol,
      this.state.trend,
      evidence.htfFvg?.id ?? "-",
      evidence.ltfSignal?.id ?? "-",
      evidence.ltfFvg?.id ?? "-",
      evidence.entryPlan ? numberKey(evidence.entryPlan.entry) : "-"
    ].join(":");
    const evidenceCount = countSetupEvidence(evidence);
    return {
      symbol: this.config.symbol,
      state: this.state.setupState,
      setupKey: evidence.htfFvg || evidence.ltfSignal || evidence.ltfFvg || evidence.entryPlan ? setupKey : null,
      trend: this.state.trend,
      htfFvg: evidence.htfFvg ? { ...evidence.htfFvg, mitigatedAt: evidence.htfFirstTouchedAt } : null,
      ltfSignal: evidence.ltfSignal,
      ltfFvg: evidence.ltfFvg ? { ...evidence.ltfFvg, mitigatedAt: evidence.ltfFirstTouchedAt } : null,
      activeLtfFvgCluster: evidence.activeLtfFvgCluster,
      frozenProtectiveCluster: evidence.frozenProtectiveCluster,
      entryPlan: evidence.entryPlan,
      evidenceCount,
      invariantOk: this.state.setupState !== "ReadyToEnter" || evidenceCount === 7
    };
  }

  async onClosedCandle(candle: Candle, options: { historical?: boolean } = {}): Promise<void> {
    if (!candle.isClosed) return;
    if (candle.symbol !== this.config.symbol) return;

    const source: FunnelSource = options.historical === true ? "BOOTSTRAP_REPLAY" : "LIVE_SCAN";
    if (candle.timeframe === "H1") {
      this.state.h1Candles.push(candle);
      await this.processH1(candle, options.historical === true, source);
      this.markState(this.state.setupState);
      return;
    }

    this.state.m5Candles.push(candle);
    await this.processM5(candle, options.historical === true, source);
    this.markState(this.state.setupState);
  }

  private async processH1(candle: Candle, historical: boolean, source: FunnelSource): Promise<void> {
    const trend = detectH1Trend(this.state.h1Candles, this.config.emaPeriod);
    this.htfTrendEstablished = Number.isFinite(trend.ema) && Number.isFinite(trend.close);

    if (trend.direction !== "neutral") {
      this.emitFunnel("HTF_NEW_CANDLE_TREND_VALID", "H1", source, undefined, trend.direction, { direction: trend.direction });
      const trendChanged = trend.direction !== this.state.trend;
      this.state.trend = trend.direction;
      if (this.state.setupState === "WaitingTrend") {
        this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "TrendConfirmed");
      }
      if (trendChanged) {
        await this.events.publish({
          type: "TrendChanged",
          at: candle.closeTime,
          symbol: candle.symbol,
          direction: trend.direction,
          reason: trend.reason
        });
      }
    } else {
      this.emitFunnel("HTF_NEW_CANDLE_TREND_NEUTRAL", "H1", source, undefined, trend.reason);
      this.state.trend = "neutral";
    }

    if (this.state.trend === "neutral") return;

    const htfFvgs = await this.syncHtfFvgCandidates(candle, historical, source);
    const currentEvidence = this.state.setupEvidence.htfFvg ? htfFvgs.find((fvg) => fvg.id === this.state.setupEvidence.htfFvg?.id) ?? null : null;
    if (currentEvidence?.status === "invalidated") {
      this.state.setupEvidence.htfFvg = currentEvidence;
      this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "Archived");
      await this.events.publish({
        type: "FVGInvalidated",
        at: candle.closeTime,
        fvg: currentEvidence,
        reason: "Closed candle fully crossed the opposite FVG boundary"
      });
    }

    const touched = htfFvgs.find((fvg) => fvg.status === "touched" && fvg.id === currentEvidence?.id);
    if (touched && !historical && touched.firstTouchedAt === candle.closeTime) {
      const activated = historical || touched.activatedAt !== undefined ? touched : { ...touched, activatedAt: touched.firstTouchedAt ?? candle.closeTime };
      await this.repository.updateFvg(activated);
      this.state.setupEvidence.htfFvg = activated;
      this.state.setupEvidence.htfFirstTouchedAt = activated.firstTouchedAt ?? activated.activatedAt ?? null;
      this.syncSetupStateWithHtfFvg(activated);
      await this.events.publish({
        type: "FVGActivated",
        at: candle.closeTime,
        fvg: activated,
        reason: "H1 FVG first touch reached the nearest boundary"
      });
      this.emitFunnel("HTF_FIRST_TOUCH_CONFIRMED", "H1", source, activated.id);
      this.markState("MonitoringLTF");
      return;
    }

    const selected = selectNearestFreshHtfFvg(htfFvgs, this.state.trend, candle.close);
    if (!selected) {
      const latestTouched = htfFvgs
        .filter((fvg) => fvg.status === "touched")
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0];
      if (latestTouched) {
        this.state.setupEvidence.htfFvg = latestTouched;
        this.state.setupEvidence.htfFirstTouchedAt = latestTouched.firstTouchedAt ?? latestTouched.activatedAt ?? null;
        this.syncSetupStateWithHtfFvg(latestTouched);
      }
      if (touched) {
        this.state.setupEvidence.htfFvg = touched;
        this.state.setupEvidence.htfFirstTouchedAt = touched.firstTouchedAt ?? touched.activatedAt ?? null;
        this.syncSetupStateWithHtfFvg(touched);
        return;
      }
      return;
    }
    if (this.state.setupState === "Archived") {
      this.resetArchivedSetup(trend.direction);
    }
    if (this.state.setupEvidence.htfFvg?.id !== selected.id) {
      if (!["WaitingTrend", "TrendConfirmed", "FVGDetected", "WaitingMitigation", "Archived"].includes(this.state.setupState)) {
        this.resetArchivedSetup(trend.direction);
      }
      this.state.setupEvidence = { ...emptySetupEvidence(), htfFvg: selected };
      this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "FVGDetected");
      this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "WaitingMitigation");
      await this.events.publish({
        type: "FVGCreated",
        at: candle.closeTime,
        fvg: selected,
        reason: "Selected nearest fresh same-direction H1 FVG by first reachable boundary"
      });
      this.emitFunnel("HTF_FVG_SELECTED", "H1", source, selected.id);
      this.emitFunnel("WAITING_HTF_FIRST_TOUCH", "H1", source, selected.id);
      this.markState("WaitingMitigation");
      return;
    }

    this.state.setupEvidence.htfFvg = selected;
    this.syncSetupStateWithHtfFvg(selected);
  }

  private async processM5(candle: Candle, historical: boolean, source: FunnelSource): Promise<void> {
    if (historical) return;
    if (this.state.setupState === "ReadyToEnter") {
      await this.processReadyToEnterM5Invalidation(candle);
      return;
    }
    if (!["MonitoringLTF", "WaitingCHOCH", "WaitingLtfFvg", "WaitingLtfMitigation"].includes(this.state.setupState)) return;

    const htfFvg = this.state.setupEvidence.htfFvg ?? (await this.repository.getActiveOrWaitingFvg(this.config.symbol, "H1"));
    const htfActivatedAt = htfFvg?.activatedAt ?? htfFvg?.firstTouchedAt;
    if (!htfFvg || htfFvg.status !== "touched" || htfActivatedAt === undefined || this.state.trend === "neutral") return;
    if (candle.closeTime < htfActivatedAt) return;

    if (!this.state.pendingSignal) {
      const signal = detectM5StructureSignal(this.state.m5Candles, this.state.trend, {
        left: this.config.swingLeft,
        right: this.config.swingRight
      });
      if (!signal || signal.direction !== this.state.trend) return;
      if (this.config.requireDisplacement && !isDisplacementSignal(this.state.m5Candles, signal, this.config.displacementLookback, this.config.displacementBodyMultiplier)) {
        this.logger.info("Structure signal ignored", { reason: "M5 break candle did not meet displacement filter", signal });
        return;
      }

      this.state.pendingSignal = signal;
      this.state.activeLtfFvgCluster = [];
      this.state.frozenProtectiveCluster = [];
      this.state.setupEvidence.ltfSignal = signal;
      this.state.setupEvidence.activeLtfFvgCluster = [];
      this.state.setupEvidence.frozenProtectiveCluster = [];
      await this.repository.saveSignal(signal);
      this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "WaitingCHOCH");
      this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "WaitingLtfFvg");
      await this.events.publish({
        type: signal.type === "BOS" ? "BOSDetected" : "CHOCHDetected",
        at: candle.closeTime,
        signal,
        reason: `${signal.type} confirmed by M5 candle body close beyond swing ${signal.brokenSwing.price}`
      });
      this.emitFunnel(signal.type === "BOS" ? "BOS_CONFIRMED" : "CHOCH_CONFIRMED", "M5", source, signal.id);
      return;
    }

    const allLtfFvgs = detectFvgs(this.state.m5Candles, "M5", this.state.pendingSignal.direction).filter(
      (fvg) => fvg.thirdCandleOpenTime > this.state.pendingSignal!.candleOpenTime
    );
    for (const fvg of allLtfFvgs.filter((candidate) => candidate.thirdCandleOpenTime === candle.openTime)) {
      this.emitFunnel("LTF_FVG_RAW_DETECTED", "M5", source, fvg.id);
      const lifecycle = reconstructFvgLifecycle(fvg, this.state.m5Candles);
      if (lifecycle.status === "touched") this.emitFunnel("LTF_FVG_ALREADY_TOUCHED", "M5", source, fvg.id);
      if (lifecycle.status === "invalidated") this.emitFunnel("LTF_FVG_INVALIDATED", "M5", source, fvg.id);
    }
    const ltfFvg = detectLatestLtfFvg(this.state.m5Candles, this.state.pendingSignal.direction, this.state.pendingSignal.candleOpenTime);
    if (ltfFvg) {
      this.emitFunnel("LTF_FVG_POST_STRUCTURE", "M5", source, ltfFvg.id);
      this.emitFunnel("LTF_FVG_DIRECTION_MATCH", "M5", source, ltfFvg.id);
      this.emitFunnel("LTF_FVG_FRESH", "M5", source, ltfFvg.id);
      this.emitFunnel("LTF_FVG_SELECTED", "M5", source, ltfFvg.id, undefined, {
        eligibleCount: allLtfFvgs.length,
        olderEligibleFvgIds: allLtfFvgs.slice(0, -1).map((fvg) => fvg.id),
        selectionReason: "latest-compatible-LTF-FVG"
      });
    }
    if (ltfFvg && !this.state.activeLtfFvgCluster.some((fvg) => fvg.id === ltfFvg.id)) {
      await this.repository.saveFvg(ltfFvg);
      this.state.activeLtfFvgCluster = [...this.state.activeLtfFvgCluster, ltfFvg];
      this.state.setupEvidence.ltfFvg = ltfFvg;
      this.state.setupEvidence.activeLtfFvgCluster = this.state.activeLtfFvgCluster;
      this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "WaitingLtfMitigation");
      await this.events.publish({
        type: "FVGCreated",
        at: candle.closeTime,
        fvg: ltfFvg,
        reason: "New untouched M5 FVG joined the active setup cluster after BOS/CHOCH"
      });
    }

    const triggeringFvg = this.state.activeLtfFvgCluster.find((fvg) => isFreshFvg(fvg) && isFvgTouched(fvg, candle));
    if (!triggeringFvg) return;

    const touchedLtfFvg = { ...triggeringFvg, status: "touched" as const, firstTouchedAt: candle.closeTime, activatedAt: candle.closeTime };
    const frozenCluster = this.state.activeLtfFvgCluster.map((fvg) => (fvg.id === touchedLtfFvg.id ? touchedLtfFvg : fvg));
    await this.repository.updateFvg(touchedLtfFvg);
    this.state.pendingLtfFvg = touchedLtfFvg;
    this.state.frozenProtectiveCluster = frozenCluster;
    this.state.setupEvidence.ltfFvg = touchedLtfFvg;
    this.state.setupEvidence.ltfFirstTouchedAt = candle.closeTime;
    this.state.setupEvidence.frozenProtectiveCluster = frozenCluster;
    await this.events.publish({
      type: "FVGActivated",
      at: candle.closeTime,
      fvg: touchedLtfFvg,
      reason: "M5 FVG first touch triggered entry and froze the active protective cluster"
    });
    this.emitFunnel("LTF_FIRST_TOUCH_CONFIRMED", "M5", source, touchedLtfFvg.id);
    this.markState("WaitingLtfMitigation");

    const planResult = await this.calculatePlanForLtfFvg(touchedLtfFvg, frozenCluster);

    if (!planResult.plan) {
      this.emitFunnel("ENTRY_PLAN_REJECTED", "M5", source, touchedLtfFvg.id, planResult.reason);
      this.logger.warn("Entry plan rejected before risk manager", {
        reason: planResult.reason,
        classification: planResult.terminal ? "PERMANENT_CANDIDATE_INVALID" : "TEMPORARY_RETRYABLE"
      });
      if (planResult.terminal) this.archiveCandidate(planResult.reason);
      return;
    }
    const plan = planResult.plan;

    this.state.setupEvidence.entryPlan = plan;
    this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "ReadyToEnter");
    this.emitFunnel("ENTRY_PLAN_CREATED", "M5", source, touchedLtfFvg.id);
    this.emitFunnel("RR_GATE_REACHED", "M5", source, touchedLtfFvg.id);
    this.emitFunnel(plan.riskReward >= this.config.minimumRiskReward ? "RR_GATE_PASSED" : "RR_GATE_REJECTED", "M5", source, touchedLtfFvg.id);
    const availableBalance = await this.getAvailableBalance();
    const currentUsedMargin = this.currentUsedMarginProvider ? await this.currentUsedMarginProvider() : 0;
    const symbolRules = await this.getSymbolRules();
    const risk = evaluateRisk({
      symbol: this.config.symbol,
      direction: plan.direction,
      availableBalance,
      symbolRules,
      riskPerTradeUsdt: this.config.riskPerTradeUsdt,
      maxLeverage: this.config.maxLeverage,
      maxMarginUsagePercent: this.config.maxMarginUsagePercent,
      maxTotalMarginUsagePercent: this.config.maxTotalMarginUsagePercent,
      currentUsedMargin: currentUsedMargin ?? 0,
      marginMode: this.config.marginMode,
      liquidationSafetyBufferPercent: this.config.liquidationSafetyBufferPercent,
      entry: plan.entry,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      minimumRiskReward: this.config.minimumRiskReward,
      openPositions: this.state.accountOpenPositions,
      maxOpenPositions: this.config.maxOpenPositions,
      symbolOpenPositions: this.state.openPositions,
      maxPositionPerSymbol: this.config.maxPositionPerSymbol,
      availableAt: candle.closeTime,
      drawdownPercent: this.state.drawdownPercent,
      maxDrawdownPercent: this.config.maxDrawdownPercent,
      tradingEnabled: this.config.tradingEnabled,
      killSwitch: this.config.killSwitch,
      createdAt: candle.closeTime
    });
    this.emitFunnel("RISK_MANAGER_REACHED", "ACCOUNT", source, touchedLtfFvg.id);
    await this.repository.saveRiskDecision(risk);
    await this.events.publish({
      type: risk.accepted ? "RiskPassed" : "RiskRejected",
      at: candle.closeTime,
      decision: risk,
      reason: risk.reason
    });

    if (!risk.accepted) {
      this.emitFunnel("RISK_REJECTED", "ACCOUNT", source, touchedLtfFvg.id, risk.rejectCode ?? risk.reason);
      this.logger.warn("[ENTRY REJECTED]", {
        symbol: this.config.symbol,
        reason: risk.rejectCode ?? risk.reason,
        entry: risk.entry,
        sl: risk.stopLoss,
        tp: risk.takeProfit,
        rr: risk.riskReward,
        minimumRR: this.config.minimumRiskReward,
        openPositions: this.state.accountOpenPositions,
        symbolOpenPositions: this.state.openPositions,
        maxOpenPositions: this.config.maxOpenPositions,
      });
      if (risk.rejectCode && terminalRiskRejectCodes.has(risk.rejectCode)) this.archiveCandidate(risk.rejectCode);
      return;
    }
    this.emitFunnel("RISK_PASSED", "ACCOUNT", source, touchedLtfFvg.id);

    let order;
    try {
      order = await this.execution.submitBracketOrder(plan, risk);
    } catch (error) {
      await this.events.publish({
        type: "OrderRejected",
        at: candle.closeTime,
        reason: error instanceof Error ? error.message : String(error)
      });
      this.state.pendingSignal = null;
      this.state.pendingLtfFvg = null;
      this.state.activeLtfFvgCluster = [];
      this.state.frozenProtectiveCluster = [];
      this.state.pendingEntryPlan = null;
      return;
    }

    this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "PositionOpened");
    this.state.openPositions += 1;
    this.state.activeRisk = risk;
    this.state.pendingSignal = null;
    this.state.pendingLtfFvg = null;
    this.state.activeLtfFvgCluster = [];
    this.state.pendingEntryPlan = null;
    await this.events.publish({
      type: "OrderSubmitted",
      at: candle.closeTime,
      orderId: order.orderId,
      reason: `Submitted ${order.mode} bracket order after risk approval`
    });
  }

  private async syncHtfFvgCandidates(candle: Candle, historical: boolean, source: FunnelSource): Promise<Fvg[]> {
    const detected = detectFvgs(this.state.h1Candles, "H1", this.state.trend as Direction);
    for (const fvg of detected.filter((candidate) => candidate.thirdCandleOpenTime === candle.openTime)) {
      this.emitFunnel("HTF_FVG_RAW_DETECTED", "H1", source, fvg.id);
      this.emitFunnel("HTF_FVG_DIRECTION_MATCH", "H1", source, fvg.id);
    }
    const lifecycles = detected.map((fvg) => {
      const lifecycle = reconstructFvgLifecycle(fvg, this.state.h1Candles);
      if (!historical && lifecycle.status === "touched" && lifecycle.firstTouchedAt === candle.closeTime) {
        return { ...lifecycle, activatedAt: candle.closeTime };
      }
      return lifecycle;
    });

    for (const fvg of lifecycles) {
      if (fvg.status === "untouched") this.emitFunnel("HTF_FVG_UNMITIGATED_ELIGIBLE", "H1", source, fvg.id);
      await this.repository.saveFvg(fvg);
    }
    return lifecycles;
  }

  private async getAvailableBalance(): Promise<number> {
    if (!this.availableBalanceProvider) return this.state.balance;

    try {
      const availableBalance = await this.availableBalanceProvider();
      if (availableBalance !== null && Number.isFinite(availableBalance)) {
        this.state.balance = availableBalance;
        return availableBalance;
      }
    } catch (error) {
      this.logger.warn("Available balance check failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return 0;
  }

  private async calculatePlanForLtfFvg(
    ltfFvg: Fvg,
    protectiveCluster: readonly Fvg[]
  ): Promise<{ plan: EntryPlan | null; reason: PlanNullReason | "NONE"; terminal: boolean }> {
    if (ltfFvg.status !== "untouched" && ltfFvg.status !== "touched") {
      return { plan: null, reason: ltfFvg.status === "invalidated" ? "INVALIDATED_STRUCTURE" : "STALE_FVG", terminal: true };
    }
    if (ltfFvg.status !== "touched" || !ltfFvg.firstTouchedAt) {
      return { plan: null, reason: "ALREADY_TOUCHED_FVG", terminal: true };
    }
    const entry = calculateFirstTouchEntry(ltfFvg);
    const decisionTimestamp = ltfFvg.firstTouchedAt ?? ltfFvg.activatedAt ?? ltfFvg.createdAt;
    const liquidityState = buildLiquidityState(this.config.symbol, "H1", this.state.h1Candles, { left: this.config.swingLeft, right: this.config.swingRight });
    const externalLiquidity = selectExternalLiquidityTarget(liquidityState, ltfFvg.direction, entry, decisionTimestamp);
    if (!externalLiquidity) return { plan: null, reason: "NO_ELIGIBLE_TP_LIQUIDITY", terminal: false };
    const symbolRules = await this.getSymbolRules();
    if (!Number.isFinite(symbolRules.tickSize) || symbolRules.tickSize <= 0) {
      return { plan: null, reason: "MISSING_SYMBOL_METADATA", terminal: false };
    }
    if (![entry, externalLiquidity.price].every((value) => Number.isFinite(value) && value > 0)) {
      return { plan: null, reason: "INVALID_RR_INPUTS", terminal: true };
    }
    if ((ltfFvg.direction === "bullish" && externalLiquidity.price <= entry) || (ltfFvg.direction === "bearish" && externalLiquidity.price >= entry)) {
      return { plan: null, reason: "INVALID_PRICE_ORDERING", terminal: true };
    }
    const plan = calculateEntryPlan({
      direction: ltfFvg.direction,
      triggeringFvg: ltfFvg,
      protectiveCluster,
      m5Candles: this.state.m5Candles,
      externalLiquidityPrice: externalLiquidity.price,
      config: {
        stopLossBufferMode: this.config.stopLossBufferMode,
        stopLossBufferTicks: this.config.stopLossBufferTicks,
        stopLossBufferPercent: this.config.stopLossBufferPercent,
        stopLossAtrPeriod: this.config.stopLossAtrPeriod,
        stopLossAtrMultiplier: this.config.stopLossAtrMultiplier,
        symbolTickSize: symbolRules.tickSize
      }
    });
    if (!plan) return { plan: null, reason: "INVALID_SL_GEOMETRY", terminal: true };
    return { plan, reason: "NONE", terminal: false };
  }

  private emitFunnel(
    stage: FunnelStage,
    timeframe: FunnelTelemetryEvent["timeframe"],
    source: FunnelSource,
    setupId?: string | null,
    reason?: string,
    metadata?: Record<string, unknown>
  ): void {
    const timestamp = Date.now();
    this.funnelCounters[stage] = (this.funnelCounters[stage] ?? 0) + 1;
    const sourceCounters = this.funnelCountersBySource[source] ?? {};
    sourceCounters[stage] = (sourceCounters[stage] ?? 0) + 1;
    this.funnelCountersBySource[source] = sourceCounters;
    this.lastFunnelEventAt = timestamp;
    const event: FunnelTelemetryEvent = {
      stage,
      accountId: this.funnelContext.accountId,
      symbol: this.config.symbol,
      timeframe,
      timestamp,
      source
    };
    if (this.funnelContext.runtimeId !== undefined) event.runtimeId = this.funnelContext.runtimeId;
    if (setupId !== undefined) event.setupId = setupId;
    if (reason !== undefined) event.reason = reason;
    if (metadata !== undefined) event.metadata = metadata;
    this.funnelContext.sink?.(event);
    this.logger.info(`[FUNNEL] ${this.funnelContext.accountId}/${this.config.symbol} ${source} ${stage}`, {
      accountId: this.funnelContext.accountId,
      runtimeId: this.funnelContext.runtimeId,
      symbol: this.config.symbol,
      timeframe,
      stage,
      setupId,
      source,
      reason,
      metadata
    });
  }

  private markState(next: SetupState): void {
    if (this.stateEnteredAt[next] === undefined || this.state.setupState !== next) this.stateEnteredAt[next] = Date.now();
    if (["WaitingMitigation", "MonitoringLTF", "WaitingLtfMitigation", "ReadyToEnter"].includes(next)) {
      this.candidateEnteredAt ??= Date.now();
    }
    if (next === "WaitingTrend" || next === "Archived") this.candidateEnteredAt = null;
  }

  private archiveCandidate(reason: string): void {
    this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "Archived");
    this.state.pendingSignal = null;
    this.state.pendingLtfFvg = null;
    this.state.activeLtfFvgCluster = [];
    this.state.frozenProtectiveCluster = [];
    this.state.pendingEntryPlan = null;
    this.candidateEnteredAt = null;
    this.logger.info("[FUNNEL] candidate archived", { accountId: this.funnelContext.accountId, symbol: this.config.symbol, reason });
  }

  private async getSymbolRules(): Promise<FuturesSymbolRules> {
    if (this.symbolRulesProvider) return this.symbolRulesProvider(this.config.symbol);
    return {
      symbol: this.config.symbol,
      status: "TRADING",
      contractType: null,
      quoteAsset: "USDT",
      marginAsset: "USDT",
      pricePrecision: null,
      quantityPrecision: null,
      tickSize: 0.1,
      minPrice: null,
      maxPrice: null,
      stepSize: 0.001,
      minQty: 0,
      maxQty: null,
      minNotional: null,
      maxLeverage: this.config.maxLeverage,
      maintenanceMarginBrackets: [],
      supportedOrderTypes: ["MARKET", "LIMIT"]
    };
  }

  private syncSetupStateWithHtfFvg(fvg: Fvg): void {
    if (isFreshFvg(fvg)) {
      this.state.setupState = advanceSetupState(this.state.setupState, "WaitingMitigation");
      return;
    }

    if (fvg.status === "touched") {
      this.state.setupEvidence.htfFirstTouchedAt = fvg.firstTouchedAt ?? fvg.activatedAt ?? null;
      this.state.setupState = advanceSetupState(this.state.setupState, "MonitoringLTF");
    }
  }

  private async processReadyToEnterM5Invalidation(candle: Candle): Promise<void> {
    const ltfFvg = this.state.setupEvidence.ltfFvg;
    if (this.state.openPositions > 0 || !ltfFvg || ltfFvg.status === "invalidated") return;
    if (!isFvgInvalidated(ltfFvg, candle)) return;

    const invalidated = { ...ltfFvg, status: "invalidated" as const, invalidatedAt: candle.closeTime };
    await this.repository.updateFvg(invalidated);
    this.state.setupEvidence.ltfFvg = invalidated;
    this.state.pendingSignal = null;
    this.state.pendingLtfFvg = null;
    this.state.activeLtfFvgCluster = [];
    this.state.frozenProtectiveCluster = [];
    this.state.pendingEntryPlan = null;
    this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "Archived");
    await this.events.publish({
      type: "FVGInvalidated",
      at: candle.closeTime,
      fvg: invalidated,
      reason: "M5 entry FVG was invalidated after ready state before position opened"
    });
  }

  private resetArchivedSetup(direction: Direction | "neutral"): void {
    this.state.setupState = "WaitingTrend";
    this.state.trend = direction;
    this.state.pendingSignal = null;
    this.state.pendingLtfFvg = null;
    this.state.activeLtfFvgCluster = [];
    this.state.frozenProtectiveCluster = [];
    this.state.pendingEntryPlan = null;
    this.state.setupEvidence = emptySetupEvidence();
    if (this.state.openPositions === 0) {
      this.state.activeRisk = null;
    }
    if (direction !== "neutral") {
      this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "TrendConfirmed");
    }
  }
}

function isDisplacementSignal(
  candles: readonly Candle[],
  signal: MarketStructureSignal,
  lookback: number,
  bodyMultiplier: number
): boolean {
  const closed = candles.filter((candle) => candle.timeframe === "M5" && candle.isClosed);
  const signalCandle = closed.find((candle) => candle.openTime === signal.candleOpenTime);
  if (!signalCandle) return false;

  const prior = closed.filter((candle) => candle.openTime < signal.candleOpenTime).slice(-lookback);
  const averageBody =
    prior.length > 0
      ? prior.reduce((sum, candle) => sum + Math.abs(candle.close - candle.open), 0) / prior.length
      : 0;
  const body = Math.abs(signalCandle.close - signalCandle.open);
  const strongClose = signal.direction === "bullish" ? signalCandle.close > signalCandle.open : signalCandle.close < signalCandle.open;
  return strongClose && body >= averageBody * bodyMultiplier;
}

function isFreshFvg(fvg: Fvg): boolean {
  return fvg.status === "untouched";
}

function selectNearestFreshHtfFvg(fvgs: readonly Fvg[], direction: Direction, currentPrice: number): Fvg | null {
  const candidates = fvgs
    .filter((fvg) => fvg.timeframe === "H1" && fvg.direction === direction && fvg.status === "untouched")
    .map((fvg) => {
      const boundary = direction === "bullish" ? fvg.upper : fvg.lower;
      const distance = direction === "bullish" ? currentPrice - boundary : boundary - currentPrice;
      return { fvg, distance };
    })
    .filter((item) => item.distance >= 0);

  candidates.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.fvg.createdAt !== b.fvg.createdAt) return b.fvg.createdAt - a.fvg.createdAt;
    return a.fvg.id.localeCompare(b.fvg.id);
  });

  return candidates[0]?.fvg ?? null;
}

function emptySetupEvidence(): SetupEvidence {
  return {
    htfFvg: null,
    htfFirstTouchedAt: null,
    ltfSignal: null,
    ltfFvg: null,
    ltfFirstTouchedAt: null,
    activeLtfFvgCluster: [],
    frozenProtectiveCluster: [],
    entryPlan: null
  };
}

export function countSetupEvidence(evidence: SetupEvidence): number {
  if (!evidence.htfFvg) return 0;
  if (!evidence.htfFirstTouchedAt) return 2;
  if (!evidence.ltfSignal) return 3;
  if (!evidence.ltfFvg) return 4;
  if (!evidence.ltfFirstTouchedAt) return 5;
  return evidence.entryPlan ? 7 : 6;
}

function numberKey(value: number): string {
  return Number(value).toFixed(8).replace(/\.?0+$/, "");
}

function transitionSetupStateIfPossible(current: SetupState, next: SetupState): SetupState {
  try {
    return transitionSetupState(current, next);
  } catch {
    return current;
  }
}

function advanceSetupState(current: SetupState, target: SetupState): SetupState {
  const mainFlow: SetupState[] = [
    "WaitingTrend",
    "TrendConfirmed",
    "FVGDetected",
    "WaitingMitigation",
    "MonitoringLTF",
    "WaitingCHOCH",
    "WaitingLtfFvg",
    "WaitingLtfMitigation",
    "ReadyToEnter",
    "PositionOpened",
    "ManagingTrade",
    "Closed",
    "Archived"
  ];
  const currentIndex = mainFlow.indexOf(current);
  const targetIndex = mainFlow.indexOf(target);
  if (currentIndex === -1 || targetIndex === -1 || targetIndex <= currentIndex) return current;

  let nextState = current;
  for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
    const targetState = mainFlow[index];
    if (!targetState) return nextState;
    nextState = transitionSetupStateIfPossible(nextState, targetState);
  }
  return nextState;
}
