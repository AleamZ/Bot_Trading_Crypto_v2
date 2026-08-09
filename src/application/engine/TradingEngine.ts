import type { AppConfig } from "../config/AppConfig.js";
import type { ExecutionGateway } from "../ports/ExecutionGateway.js";
import type { DecisionLogger } from "../ports/Logger.js";
import type { TradingRepository } from "../ports/Repositories.js";
import { EventBus } from "./EventBus.js";
import type { Candle } from "../../domain/market-data/Candle.js";
import type { Direction } from "../../domain/trade/Direction.js";
import { detectH1Trend } from "../../domain/trend/TrendDetector.js";
import type { Fvg } from "../../domain/fvg/Fvg.js";
import { detectLatestHtfFvg, detectLatestLtfFvg, isFvgInvalidated, isFvgMitigated } from "../../domain/fvg/FvgDetector.js";
import type { MarketStructureSignal } from "../../domain/market-structure/MarketStructureSignal.js";
import { detectM5StructureSignal } from "../../domain/market-structure/StructureDetector.js";
import { detectSwings } from "../../domain/market-structure/Swing.js";
import { selectExternalLiquidityTarget } from "../../domain/liquidity/LiquidityDetector.js";
import { calculateEntryPlan, calculateFvgEntry, type EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";
import { evaluateRisk } from "../../domain/risk/RiskManager.js";
import { transitionSetupState, type SetupState } from "../../domain/setup/SetupStateMachine.js";

export interface EngineState {
  setupState: SetupState;
  trend: Direction | "neutral";
  balance: number;
  h1Candles: Candle[];
  m5Candles: Candle[];
  openPositions: number;
  tradesToday: number;
  consecutiveLosses: number;
  lastClosedTradeAt: number | null;
  dailyLossPercent: number;
  drawdownPercent: number;
  pendingSignal: MarketStructureSignal | null;
  pendingLtfFvg: Fvg | null;
  pendingEntryPlan: EntryPlan | null;
  activeRisk: RiskDecision | null;
}

export type AvailableBalanceProvider = () => Promise<number | null>;

export class TradingEngine {
  readonly events: EventBus;
  private state: EngineState;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: TradingRepository,
    private readonly execution: ExecutionGateway,
    private readonly logger: DecisionLogger,
    private readonly availableBalanceProvider: AvailableBalanceProvider | null = null,
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
      tradesToday: 0,
      consecutiveLosses: 0,
      lastClosedTradeAt: null,
      dailyLossPercent: 0,
      drawdownPercent: 0,
      pendingSignal: null,
      pendingLtfFvg: null,
      pendingEntryPlan: null,
      activeRisk: null
    };
  }

  getState(): Readonly<EngineState> {
    return this.state;
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
              plan: this.state.pendingEntryPlan
            }
          : null,
      activeRisk: this.state.activeRisk
    };
  }

  async onClosedCandle(candle: Candle): Promise<void> {
    if (!candle.isClosed) return;
    if (candle.symbol !== this.config.symbol) return;

    if (candle.timeframe === "H1") {
      this.state.h1Candles.push(candle);
      await this.processH1(candle);
      return;
    }

    this.state.m5Candles.push(candle);
    await this.processM5(candle);
  }

  private async processH1(candle: Candle): Promise<void> {
    const trend = detectH1Trend(this.state.h1Candles, this.config.emaPeriod);
    if (trend.direction !== "neutral" && trend.direction !== this.state.trend) {
      this.state.trend = trend.direction;
      this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "TrendConfirmed");
      await this.events.publish({
        type: "TrendChanged",
        at: candle.closeTime,
        symbol: candle.symbol,
        direction: trend.direction,
        reason: trend.reason
      });
    }

    if (this.state.trend === "neutral") return;

    const existingFvg = await this.repository.getActiveOrWaitingFvg(this.config.symbol, "H1");
    if (existingFvg) {
      if (isFvgInvalidated(existingFvg, candle)) {
        const invalidated = { ...existingFvg, status: "invalidated" as const, invalidatedAt: candle.closeTime };
        await this.repository.updateFvg(invalidated);
        this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "Archived");
        await this.events.publish({
          type: "FVGInvalidated",
          at: candle.closeTime,
          fvg: invalidated,
          reason: "Closed candle fully crossed the opposite FVG boundary"
        });
        return;
      }

      if (existingFvg.status === "waiting-mitigation" && isFvgMitigated(existingFvg, candle, this.config.fvgMitigation)) {
        const active = { ...existingFvg, status: "active" as const, activatedAt: candle.closeTime };
        await this.repository.updateFvg(active);
        this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "MonitoringLTF");
        await this.events.publish({
          type: "FVGActivated",
          at: candle.closeTime,
          fvg: active,
          reason: `FVG mitigation mode ${this.config.fvgMitigation} was met`
        });
      }
      return;
    }

    const fvg = detectLatestHtfFvg(this.state.h1Candles, this.state.trend);
    if (!fvg) return;

    await this.repository.saveFvg(fvg);
    this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "FVGDetected");
    this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "WaitingMitigation");
    await this.events.publish({
      type: "FVGCreated",
      at: candle.closeTime,
      fvg,
      reason: "Three closed H1 candles formed a valid trend-aligned FVG"
    });
  }

  private async processM5(candle: Candle): Promise<void> {
    if (!["MonitoringLTF", "WaitingCHOCH", "WaitingLtfFvg", "WaitingLtfMitigation"].includes(this.state.setupState)) return;

    const htfFvg = await this.repository.getActiveOrWaitingFvg(this.config.symbol, "H1");
    if (!htfFvg || htfFvg.status !== "active" || this.state.trend === "neutral") return;
    if (htfFvg.activatedAt !== undefined && candle.closeTime < htfFvg.activatedAt) return;

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

    if (!this.state.pendingLtfFvg) {
      const ltfFvg = detectLatestLtfFvg(this.state.m5Candles, this.state.pendingSignal.direction, this.state.pendingSignal.candleOpenTime);
      if (!ltfFvg) return;

      await this.repository.saveFvg(ltfFvg);
      this.state.pendingLtfFvg = ltfFvg;
      this.state.pendingEntryPlan = this.calculatePlanForLtfFvg(ltfFvg);
      if (!this.state.pendingEntryPlan) {
        this.logger.warn("Pending M5 FVG ignored", { reason: "Could not build entry plan from M5 FVG" });
        return;
      }
      this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "WaitingLtfMitigation");
      await this.events.publish({
        type: "FVGCreated",
        at: candle.closeTime,
        fvg: ltfFvg,
        reason: "New M5 FVG formed after BOS/CHOCH in the same direction"
      });
      return;
    }

    if (isFvgInvalidated(this.state.pendingLtfFvg, candle)) {
      const invalidated = { ...this.state.pendingLtfFvg, status: "invalidated" as const, invalidatedAt: candle.closeTime };
      await this.repository.updateFvg(invalidated);
      this.state.pendingSignal = null;
      this.state.pendingLtfFvg = null;
      this.state.pendingEntryPlan = null;
      this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "Archived");
      await this.events.publish({
        type: "FVGInvalidated",
        at: candle.closeTime,
        fvg: invalidated,
        reason: "M5 entry FVG was invalidated before entry"
      });
      return;
    }

    if (!isFvgMitigated(this.state.pendingLtfFvg, candle, this.config.ltfFvgEntryMode)) return;

    const activeLtfFvg = { ...this.state.pendingLtfFvg, status: "active" as const, activatedAt: candle.closeTime };
    await this.repository.updateFvg(activeLtfFvg);
    this.state.pendingLtfFvg = activeLtfFvg;
    await this.events.publish({
      type: "FVGActivated",
      at: candle.closeTime,
      fvg: activeLtfFvg,
      reason: `M5 entry FVG mitigation mode ${this.config.ltfFvgEntryMode} was met`
    });

    const plan = this.calculatePlanForLtfFvg(activeLtfFvg);

    if (!plan) {
      this.logger.warn("Entry plan rejected before risk manager", {
        reason: "Missing valid SL/TP or non-positive reward/risk"
      });
      return;
    }

    this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "ReadyToEnter");
    const availableBalance = await this.getAvailableBalance();
    const risk = evaluateRisk({
      symbol: this.config.symbol,
      direction: plan.direction,
      availableBalance,
      marginPerTrade: this.config.marginPerTrade,
      leverage: this.config.leverage,
      maxLeverage: this.config.maxLeverage,
      entry: plan.entry,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      minimumRiskReward: this.config.minimumRiskReward,
      minNotional: this.config.minNotional,
      maxPositionSize: this.config.maxPositionSize,
      openPositions: this.state.openPositions,
      maxOpenPositions: this.config.maxOpenPositions,
      tradesToday: this.state.tradesToday,
      maxTradesPerDay: this.config.maxTradesPerDay,
      dailyRealizedLoss: availableBalance * (this.state.dailyLossPercent / 100),
      dailyLossLimitPercent: this.config.maxDailyLossPercent,
      consecutiveLosses: this.state.consecutiveLosses,
      maxConsecutiveLosses: this.config.maxConsecutiveLosses,
      lastClosedTradeAt: this.state.lastClosedTradeAt,
      cooldownAfterTradeMinutes: this.config.cooldownAfterTradeMinutes,
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
        openPositions: this.state.openPositions,
        maxOpenPositions: this.config.maxOpenPositions,
        tradesToday: this.state.tradesToday,
        maxTradesPerDay: this.config.maxTradesPerDay
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
      this.state.pendingEntryPlan = null;
      return;
    }

    this.state.setupState = transitionSetupStateIfPossible(this.state.setupState, "PositionOpened");
    this.state.openPositions += 1;
    this.state.tradesToday += 1;
    this.state.activeRisk = risk;
    this.state.pendingSignal = null;
    this.state.pendingLtfFvg = null;
    this.state.pendingEntryPlan = null;
    await this.events.publish({
      type: "OrderSubmitted",
      at: candle.closeTime,
      orderId: order.orderId,
      reason: `Submitted ${order.mode} bracket order after risk approval`
    });
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

  private calculatePlanForLtfFvg(ltfFvg: Fvg): EntryPlan | null {
    const h1Swings = detectSwings(this.state.h1Candles, { left: this.config.swingLeft, right: this.config.swingRight });
    const entry = calculateFvgEntry(ltfFvg, this.config.ltfFvgEntryMode);
    const externalLiquidity = selectExternalLiquidityTarget(h1Swings, ltfFvg.direction, entry);
    return calculateEntryPlan({
      direction: ltfFvg.direction,
      ltfFvg,
      m5Candles: this.state.m5Candles,
      externalLiquidityPrice: externalLiquidity?.price ?? null,
      config: {
        entryFvgMitigation: this.config.ltfFvgEntryMode,
        takeProfitMode: this.config.takeProfitMode,
        fixedRr: this.config.fixedRr,
        stopLossBufferMode: this.config.stopLossBufferMode,
        stopLossBufferTicks: this.config.stopLossBufferTicks,
        stopLossBufferPercent: this.config.stopLossBufferPercent,
        stopLossAtrPeriod: this.config.stopLossAtrPeriod,
        stopLossAtrMultiplier: this.config.stopLossAtrMultiplier,
        priceTickSize: this.config.priceTickSize
      }
    });
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

function transitionSetupStateIfPossible(current: SetupState, next: SetupState): SetupState {
  try {
    return transitionSetupState(current, next);
  } catch {
    return current;
  }
}
