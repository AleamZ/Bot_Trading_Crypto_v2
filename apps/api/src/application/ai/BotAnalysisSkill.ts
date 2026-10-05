import type { AppConfig } from "../config/AppConfig.js";
import type { SetupDiagnostic } from "../engine/TradingEngine.js";
import type { Candle } from "../../domain/market-data/Candle.js";
import type { Direction } from "../../domain/trade/Direction.js";
import { buildRuntimeSetupConditions, type AnalysisStatus } from "../../presentation/http/Server.js";
import type { LlmChatMessage } from "./LocalLlmClient.js";

/**
 * The "bot analysis skill": a compact, deterministic description of the engine's own 7-step
 * analysis that an LLM reads to decide whether the bot should place an order. The same
 * constants render docs/ai/bot-analysis-skill.md (npm run ai:skill-doc -w @smc-futures-bot/api).
 */
export const BOT_ANALYSIS_SKILL_NAME = "smc-bot-analysis";
export const BOT_ANALYSIS_SKILL_VERSION = 1;

const M5_SUMMARY_CANDLES = 12;
const H1_SUMMARY_CANDLES = 6;

/** The seven counted conditions, in the order of countSetupEvidence; ids match the analysis UI. */
export const BOT_ANALYSIS_RULES: ReadonlyArray<{ id: string; title: string; rule: string }> = [
  { id: "h1-trend", title: "H1 EMA trend", rule: "The H1 close relative to the H1 EMA sets the only tradable direction (bullish or bearish). Neutral means no trade." },
  { id: "htf-fvg", title: "Fresh H1 FVG", rule: "A same-direction H1 fair value gap (3-candle rule) that is still UNTOUCHED when selected." },
  { id: "htf-fvg-first-touch", title: "H1 FVG first touch", rule: "The first wick touch of the H1 FVG nearest boundary (bullish: low <= upper, bearish: high >= lower) activates the HTF context." },
  { id: "m5-structure", title: "M5 BOS/CHOCH", rule: "After the H1 touch, an M5 candle BODY CLOSE beyond the relevant swing in the trend direction. Wick-only breaks do not count." },
  { id: "m5-fvg", title: "M5 FVG in the active cluster", rule: "New untouched same-direction M5 FVGs created after the BOS/CHOCH candle form the active cluster. Older, opposite or touched FVGs are excluded." },
  { id: "m5-fvg-pullback", title: "M5 first touch", rule: "The entry trigger is the FIRST wick touch of an eligible cluster FVG. Creating an FVG is not a trigger. The cluster is frozen at this moment." },
  {
    id: "entry-plan",
    title: "Entry plan",
    rule: "Entry at the triggering FVG boundary (bullish: upper, bearish: lower). SL outside the whole frozen cluster plus buffer (long: min lower - buffer, short: max upper + buffer). TP at HTF external liquidity (no fixed-RR fallback). RR = |TP - entry| / |entry - SL| must reach minimumRiskReward. 1R sizing: quantity = riskPerTradeUsdt / |entry - SL|."
  }
];

/** Checks the bot applies to every AI decision; anything failing is rejected and never executed. */
export const BOT_ANALYSIS_HARD_CONSTRAINTS: readonly string[] = [
  "direction must equal the current H1 trend.",
  "entry, stopLoss and takeProfit must be finite numbers > 0. Long: stopLoss < entry < takeProfit. Short: takeProfit < entry < stopLoss.",
  "The live price must be strictly between stopLoss and takeProfit.",
  "RR is measured from the executable entry (the live price for MARKET entries or when a LIMIT price is already crossed) and must be >= risk.minimumRiskReward.",
  "confidence must be >= risk.aiMinConfidence.",
  "When the bot has a plan, stopLoss may be WIDER than plan.stopLoss but never tighter (long: <= plan.stopLoss, short: >= plan.stopLoss).",
  "Do not shrink the stop or invent a take profit beyond HTF liquidity just to make RR pass.",
  "Accepted decisions still pass the bot's own risk manager, kill switch, trading toggle, daily/account protection and position limits."
];

export const AI_DECISION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "symbol", "direction", "entry", "stopLoss", "takeProfit", "confidence", "reason"],
  properties: {
    action: { type: "string", enum: ["ENTER", "SKIP"] },
    symbol: { type: "string", description: "Must equal snapshot.symbol" },
    direction: { type: "string", enum: ["bullish", "bearish"] },
    entry: { type: "number", minimum: 0, description: "> 0 for ENTER; 0 allowed for SKIP" },
    stopLoss: { type: "number", minimum: 0, description: "> 0 for ENTER; 0 allowed for SKIP" },
    takeProfit: { type: "number", minimum: 0, description: "> 0 for ENTER; 0 allowed for SKIP" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string", maxLength: 400 }
  }
} as const;

export const AI_DECISION_EXAMPLE = {
  action: "SKIP",
  symbol: "BTCUSDT",
  direction: "bullish",
  entry: 0,
  stopLoss: 0,
  takeProfit: 0,
  confidence: 0.4,
  reason: "M5 first touch has not happened yet; no executable entry."
} as const;

export const AI_DECISION_SYSTEM_PROMPT = [
  "You are the trade gate of a Binance USDT-M Futures ICT/SMC bot. You read the bot's own analysis snapshot and decide whether the bot should place ONE bracket order now.",
  "",
  "Strategy (7 counted conditions, all from the bot):",
  ...BOT_ANALYSIS_RULES.map((rule, index) => `${index + 1}. ${rule.title} [${rule.id}]: ${rule.rule}`),
  "",
  "With fewer than 7/7 conditions passed the strategy has not triggered: ENTER only with a clear reason, otherwise SKIP.",
  "",
  "Hard constraints (the bot rejects any decision that breaks one):",
  ...BOT_ANALYSIS_HARD_CONSTRAINTS.map((constraint) => `- ${constraint}`),
  "",
  "When in doubt, SKIP. For SKIP you may set entry, stopLoss and takeProfit to 0.",
  "Reply with exactly one JSON object and nothing else, matching this JSON schema:",
  JSON.stringify(AI_DECISION_OUTPUT_SCHEMA)
].join("\n");

export interface BotAnalysisCondition {
  id: string;
  label: string;
  passed: boolean;
  status: AnalysisStatus;
  detail: string;
  values: Record<string, number | string | null>;
}

export interface CandleSummary {
  timeframe: "H1" | "M5";
  /** [openTime ms, open, high, low, close], oldest first. */
  candles: Array<[number, number, number, number, number]>;
  high: number | null;
  low: number | null;
}

export interface BotAnalysisSnapshot {
  skill: { name: string; version: number };
  symbol: string;
  at: number;
  setupState: SetupDiagnostic["state"];
  trend: Direction | "neutral";
  livePrice: number | null;
  evidence: { passed: number; total: 7; readyToEnter: boolean };
  conditions: BotAnalysisCondition[];
  plan: {
    direction: Direction;
    entry: number;
    stopLoss: number;
    takeProfit: number;
    riskReward: number;
    structuralStopBoundary: number;
    stopLossBuffer: number;
  } | null;
  market: { h1: CandleSummary; m5: CandleSummary };
  risk: {
    minimumRiskReward: number;
    riskPerTradeUsdt: number;
    maxLeverage: number;
    maxOpenPositions: number;
    maxPositionPerSymbol: number;
    entryMode: AppConfig["entryMode"];
    marginMode: AppConfig["marginMode"];
    aiMinConfidence: number;
  };
  positions: { accountOpen: number; symbolOpen: number };
  lastRejection: SetupDiagnostic["lastRejection"];
}

export interface BotAnalysisSnapshotInput {
  diagnostic: SetupDiagnostic;
  config: AppConfig;
  livePrice: number | null;
  h1Candles: readonly Candle[];
  m5Candles: readonly Candle[];
  accountOpenPositions: number;
  symbolOpenPositions: number;
  at: number;
}

export function buildBotAnalysisSnapshot(input: BotAnalysisSnapshotInput): BotAnalysisSnapshot {
  const { diagnostic, config } = input;
  const plan = diagnostic.entryPlan;
  const conditions = buildRuntimeSetupConditions(diagnostic.symbol, diagnostic, config).map((condition) => ({
    id: condition.id,
    label: condition.label,
    passed: condition.status === "PASSED",
    status: condition.status,
    detail: condition.detail,
    values: conditionValues(condition.id, diagnostic)
  }));
  return {
    skill: { name: BOT_ANALYSIS_SKILL_NAME, version: BOT_ANALYSIS_SKILL_VERSION },
    symbol: diagnostic.symbol,
    at: input.at,
    setupState: diagnostic.state,
    trend: diagnostic.trend,
    livePrice: finiteOrNull(input.livePrice),
    evidence: { passed: diagnostic.state === "Archived" ? 0 : diagnostic.evidenceCount, total: 7, readyToEnter: diagnostic.state === "ReadyToEnter" },
    conditions,
    plan: plan
      ? {
          direction: plan.direction,
          entry: plan.entry,
          stopLoss: plan.stopLoss,
          takeProfit: plan.takeProfit,
          riskReward: plan.riskReward,
          structuralStopBoundary: plan.structuralStopBoundary,
          stopLossBuffer: plan.stopLossBuffer
        }
      : null,
    market: {
      h1: summarizeCandles("H1", input.h1Candles, H1_SUMMARY_CANDLES),
      m5: summarizeCandles("M5", input.m5Candles, M5_SUMMARY_CANDLES)
    },
    risk: {
      minimumRiskReward: config.minimumRiskReward,
      riskPerTradeUsdt: config.riskPerTradeUsdt,
      maxLeverage: config.maxLeverage,
      maxOpenPositions: config.maxOpenPositions,
      maxPositionPerSymbol: config.maxPositionPerSymbol,
      entryMode: config.entryMode,
      marginMode: config.marginMode,
      aiMinConfidence: config.aiMinConfidence
    },
    positions: { accountOpen: input.accountOpenPositions, symbolOpen: input.symbolOpenPositions },
    lastRejection: diagnostic.lastRejection
  };
}

export function buildAiDecisionMessages(snapshot: BotAnalysisSnapshot): LlmChatMessage[] {
  return [
    { role: "system", content: AI_DECISION_SYSTEM_PROMPT },
    { role: "user", content: `Bot analysis snapshot:\n${JSON.stringify(snapshot)}\n\nReturn the JSON decision for ${snapshot.symbol}.` }
  ];
}

function conditionValues(id: string, diagnostic: SetupDiagnostic): Record<string, number | string | null> {
  const htf = diagnostic.htfFvg;
  const ltf = diagnostic.ltfFvg;
  const signal = diagnostic.ltfSignal;
  const plan = diagnostic.entryPlan;
  switch (id) {
    case "h1-trend":
      return { trend: diagnostic.trend };
    case "htf-fvg":
      return htf ? { lower: htf.lower, upper: htf.upper, status: htf.status, createdAt: htf.createdAt } : {};
    case "htf-fvg-first-touch":
      return { touchedAt: htf?.mitigatedAt ?? null };
    case "m5-structure":
      return signal ? { type: signal.type, close: signal.close, brokenSwing: signal.brokenSwing.price, at: signal.candleOpenTime } : {};
    case "m5-fvg":
      return ltf ? { lower: ltf.lower, upper: ltf.upper, status: ltf.status, clusterSize: diagnostic.activeLtfFvgCluster.length } : {};
    case "m5-fvg-pullback":
      return { touchedAt: ltf?.mitigatedAt ?? null };
    case "entry-plan":
      return plan ? { entry: plan.entry, stopLoss: plan.stopLoss, takeProfit: plan.takeProfit, riskReward: round(plan.riskReward, 4) } : {};
    default:
      return {};
  }
}

function summarizeCandles(timeframe: "H1" | "M5", candles: readonly Candle[], count: number): CandleSummary {
  const recent = candles.filter((candle) => candle.timeframe === timeframe && candle.isClosed).slice(-count);
  return {
    timeframe,
    candles: recent.map((candle) => [candle.openTime, candle.open, candle.high, candle.low, candle.close]),
    high: recent.length > 0 ? Math.max(...recent.map((candle) => candle.high)) : null,
    low: recent.length > 0 ? Math.min(...recent.map((candle) => candle.low)) : null
  };
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Renders the skill as Markdown for humans and other agents (docs/ai/bot-analysis-skill.md). */
export function renderBotAnalysisSkillMarkdown(): string {
  const lines = [
    `# Bot analysis skill (\`${BOT_ANALYSIS_SKILL_NAME}\` v${BOT_ANALYSIS_SKILL_VERSION})`,
    "",
    "<!-- Generated from apps/api/src/application/ai/BotAnalysisSkill.ts. Do not edit by hand: run `npm run ai:skill-doc -w @smc-futures-bot/api`. -->",
    "",
    "A local OpenAI-compatible LLM reads the bot's own 7-step ICT/SMC analysis for one symbol and decides whether the bot should place an order. The strategy source of truth is `trading_rules.md`.",
    "",
    "## When the AI is consulted",
    "",
    "- Account setting `aiTradingMode` is `ADVISORY` or `AUTO` (`OFF` never calls the model).",
    "- At most once per symbol per closed M5 candle, during the live scan (never during bootstrap replay).",
    "- Only when the setup has at least 5/7 conditions or is `ReadyToEnter`, and the symbol has no open position, resting entry or open execution intent.",
    "- The call runs in the background; LLM errors and timeouts are logged and never block the strategy engine.",
    "- `ADVISORY` only records decisions. `AUTO` may place orders on DEMO accounts only; REAL accounts never auto-trade.",
    "",
    "## The 7 conditions",
    "",
    "| # | id | Condition | Rule |",
    "|---|----|-----------|------|",
    ...BOT_ANALYSIS_RULES.map((rule, index) => `| ${index + 1} | \`${rule.id}\` | ${rule.title} | ${rule.rule.replace(/\|/g, "\\|")} |`),
    "",
    "## Hard constraints enforced by the bot",
    "",
    ...BOT_ANALYSIS_HARD_CONSTRAINTS.map((constraint) => `- ${constraint}`),
    "",
    "## Input snapshot",
    "",
    "The user message carries one JSON object (`BotAnalysisSnapshot`) with these fields:",
    "",
    "- `skill`: name and version of this skill.",
    "- `symbol`, `at` (decision time, ms), `setupState` (engine state), `trend` (`bullish` / `bearish` / `neutral`), `livePrice`.",
    "- `evidence`: `{ passed, total: 7, readyToEnter }`.",
    "- `conditions[]`: the 7 conditions in order, each `{ id, label, passed, status, detail, values }`.",
    "- `plan`: the strategy plan `{ direction, entry, stopLoss, takeProfit, riskReward, structuralStopBoundary, stopLossBuffer }` or `null`.",
    `- \`market.h1\` / \`market.m5\`: the last ${H1_SUMMARY_CANDLES} H1 and ${M5_SUMMARY_CANDLES} M5 closed candles as \`[openTime, open, high, low, close]\` plus their high/low.`,
    "- `risk`: `minimumRiskReward`, `riskPerTradeUsdt`, `maxLeverage`, `maxOpenPositions`, `maxPositionPerSymbol`, `entryMode`, `marginMode`, `aiMinConfidence`.",
    "- `positions`: `{ accountOpen, symbolOpen }`.",
    "- `lastRejection`: why the last ready setup did not become an order (`{ code, reason, at }`) or `null`.",
    "",
    "## Output",
    "",
    "Exactly one JSON object, no prose, matching:",
    "",
    "```json",
    JSON.stringify(AI_DECISION_OUTPUT_SCHEMA, null, 2),
    "```",
    "",
    "Example:",
    "",
    "```json",
    JSON.stringify(AI_DECISION_EXAMPLE, null, 2),
    "```",
    "",
    "## System prompt",
    "",
    "```text",
    AI_DECISION_SYSTEM_PROMPT,
    "```",
    ""
  ];
  return lines.join("\n");
}
