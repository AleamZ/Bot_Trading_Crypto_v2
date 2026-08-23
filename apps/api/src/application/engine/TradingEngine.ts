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
import { detectSwings } from "../../domain/market-structure/Swing.js";
import { selectExternalLiquidityTarget } from "../../domain/liquidity/LiquidityDetector.js";
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
export type SymbolRulesProvider = (symbol: string) => Promise<FuturesSymbolRules>;

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
    initialBalance = 10_000
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
      selectedLeverage: 0,
      requiredMargin: 0,
      maxLeverage: this.config.maxLeverage,
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

    if (candle.timeframe === "H1") {
      this.state.h1Candles.push(candle);
      await this.processH1(candle, options.historical === true);
      return;
    }

    this.state.m5Candles.push(candle);
    await this.processM5(candle, options.historical === true);
  }

  private async processH1(candle: Candle, historical: boolean): Promise<void> {
    const trend = detectH1Trend(this.state.h1Candles, this.config.emaPeriod);

    if (trend.direction !== "neutral") {
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
      this.state.trend = "neutral";
    }

    if (this.state.trend === "neutral") return;

    const htfFvgs = await this.syncHtfFvgCandidates(candle, historical);
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
      return;
    }

    this.state.setupEvidence.htfFvg = selected;
    this.syncSetupStateWithHtfFvg(selected);
  }

  private async processM5(candle: Candle, historical: boolean): Promise<void> {
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
      return;
    }

    const ltfFvg = detectLatestLtfFvg(this.state.m5Candles, this.state.pendingSignal.direction, this.state.pendingSignal.candleOpenTime);
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

    const plan = await this.calculatePlanForLtfFvg(touchedLtfFvg, frozenCluster);

    if (!plan) {
      this.logger.warn("Entry plan rejected before risk manager", {
        reason: "Missing valid SL/TP or non-positive reward/risk"
      });
      return;
    }

    this.state.setupEvidence.entryPlan = plan;
    this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "ReadyToEnter");
    const availableBalance = await this.getAvailableBalance();
    const symbolRules = await this.getSymbolRules();
    const risk = evaluateRisk({
      symbol: this.config.symbol,
      direction: plan.direction,
      availableBalance,
      symbolRules,
      riskPerTradeUsdt: this.config.riskPerTradeUsdt,
      maxLeverage: this.config.maxLeverage,
      maxMarginUsagePercent: this.config.maxMarginUsagePercent,
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
    await this.repository.saveRiskDecision(risk);
    await this.events.publish({
      type: risk.accepted ? "RiskPassed" : "RiskRejected",
      at: candle.closeTime,
      decision: risk,
      reason: risk.reason
    });

    if (!risk.accepted) {
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
      return;
    }

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

  private async syncHtfFvgCandidates(candle: Candle, historical: boolean): Promise<Fvg[]> {
    const detected = detectFvgs(this.state.h1Candles, "H1", this.state.trend as Direction);
    const lifecycles = detected.map((fvg) => {
      const lifecycle = reconstructFvgLifecycle(fvg, this.state.h1Candles);
      if (!historical && lifecycle.status === "touched" && lifecycle.firstTouchedAt === candle.closeTime) {
        return { ...lifecycle, activatedAt: candle.closeTime };
      }
      return lifecycle;
    });

    for (const fvg of lifecycles) {
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

  private async calculatePlanForLtfFvg(ltfFvg: Fvg, protectiveCluster: readonly Fvg[]): Promise<EntryPlan | null> {
    const h1Swings = detectSwings(this.state.h1Candles, { left: this.config.swingLeft, right: this.config.swingRight });
    const entry = calculateFirstTouchEntry(ltfFvg);
    const externalLiquidity = selectExternalLiquidityTarget(h1Swings, ltfFvg.direction, entry);
    const symbolRules = await this.getSymbolRules();
    return calculateEntryPlan({
      direction: ltfFvg.direction,
      triggeringFvg: ltfFvg,
      protectiveCluster,
      m5Candles: this.state.m5Candles,
      externalLiquidityPrice: externalLiquidity?.price ?? null,
      config: {
        stopLossBufferMode: this.config.stopLossBufferMode,
        stopLossBufferTicks: this.config.stopLossBufferTicks,
        stopLossBufferPercent: this.config.stopLossBufferPercent,
        stopLossAtrPeriod: this.config.stopLossAtrPeriod,
        stopLossAtrMultiplier: this.config.stopLossAtrMultiplier,
        symbolTickSize: symbolRules.tickSize
      }
    });
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
