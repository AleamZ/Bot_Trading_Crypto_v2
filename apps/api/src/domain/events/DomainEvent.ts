import type { Direction } from "../trade/Direction.js";
import type { Fvg } from "../fvg/Fvg.js";
import type { MarketStructureSignal } from "../market-structure/MarketStructureSignal.js";
import type { RiskDecision } from "../risk/RiskDecision.js";

export type DomainEvent =
  | { type: "TrendChanged"; at: number; symbol: string; direction: Direction; reason: string }
  | { type: "FVGCreated"; at: number; fvg: Fvg; reason: string }
  | { type: "FVGActivated"; at: number; fvg: Fvg; reason: string }
  | { type: "FVGInvalidated"; at: number; fvg: Fvg; reason: string }
  | { type: "BOSDetected"; at: number; signal: MarketStructureSignal; reason: string }
  | { type: "CHOCHDetected"; at: number; signal: MarketStructureSignal; reason: string }
  | { type: "RiskPassed"; at: number; decision: RiskDecision; reason: string }
  | { type: "RiskRejected"; at: number; decision: RiskDecision; reason: string }
  | { type: "OrderSubmitted"; at: number; orderId: string; reason: string }
  | { type: "OrderRejected"; at: number; reason: string }
  | { type: "PositionOpened"; at: number; tradeId: string; reason: string }
  | { type: "PositionClosed"; at: number; tradeId: string; reason: string }
  | { type: "TradeCompleted"; at: number; tradeId: string; reason: string };
