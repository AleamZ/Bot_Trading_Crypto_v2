# Bot analysis skill (`smc-bot-analysis` v1)

<!-- Generated from apps/api/src/application/ai/BotAnalysisSkill.ts. Do not edit by hand: run `npm run ai:skill-doc -w @smc-futures-bot/api`. -->

A local OpenAI-compatible LLM reads the bot's own 7-step ICT/SMC analysis for one symbol and decides whether the bot should place an order. The strategy source of truth is `trading_rules.md`.

## When the AI is consulted

- Account setting `aiTradingMode` is `ADVISORY` or `AUTO` (`OFF` never calls the model).
- At most once per symbol per closed M5 candle, during the live scan (never during bootstrap replay).
- Only when the setup has at least 5/7 conditions or is `ReadyToEnter`, and the symbol has no open position, resting entry or open execution intent.
- The call runs in the background; LLM errors and timeouts are logged and never block the strategy engine.
- `ADVISORY` only records decisions. `AUTO` may place orders on DEMO accounts only; REAL accounts never auto-trade.

## The 7 conditions

| # | id | Condition | Rule |
|---|----|-----------|------|
| 1 | `h1-trend` | H1 EMA trend | The H1 close relative to the H1 EMA sets the only tradable direction (bullish or bearish). Neutral means no trade. |
| 2 | `htf-fvg` | Fresh H1 FVG | A same-direction H1 fair value gap (3-candle rule) that is still UNTOUCHED when selected. |
| 3 | `htf-fvg-first-touch` | H1 FVG first touch | The first wick touch of the H1 FVG nearest boundary (bullish: low <= upper, bearish: high >= lower) activates the HTF context. |
| 4 | `m5-structure` | M5 BOS/CHOCH | After the H1 touch, an M5 candle BODY CLOSE beyond the relevant swing in the trend direction. Wick-only breaks do not count. |
| 5 | `m5-fvg` | M5 FVG in the active cluster | New untouched same-direction M5 FVGs created after the BOS/CHOCH candle form the active cluster. Older, opposite or touched FVGs are excluded. |
| 6 | `m5-fvg-pullback` | M5 first touch | The entry trigger is the FIRST wick touch of an eligible cluster FVG. Creating an FVG is not a trigger. The cluster is frozen at this moment. |
| 7 | `entry-plan` | Entry plan | Entry at the triggering FVG boundary (bullish: upper, bearish: lower). SL outside the whole frozen cluster plus buffer (long: min lower - buffer, short: max upper + buffer). TP at HTF external liquidity (no fixed-RR fallback). RR = \|TP - entry\| / \|entry - SL\| must reach minimumRiskReward. 1R sizing: quantity = riskPerTradeUsdt / \|entry - SL\|. |

## Hard constraints enforced by the bot

- direction must equal the current H1 trend.
- entry, stopLoss and takeProfit must be finite numbers > 0. Long: stopLoss < entry < takeProfit. Short: takeProfit < entry < stopLoss.
- The live price must be strictly between stopLoss and takeProfit.
- RR is measured from the executable entry (the live price for MARKET entries or when a LIMIT price is already crossed) and must be >= risk.minimumRiskReward.
- confidence must be >= risk.aiMinConfidence.
- When the bot has a plan, stopLoss may be WIDER than plan.stopLoss but never tighter (long: <= plan.stopLoss, short: >= plan.stopLoss).
- Do not shrink the stop or invent a take profit beyond HTF liquidity just to make RR pass.
- Accepted decisions still pass the bot's own risk manager, kill switch, trading toggle, daily/account protection and position limits.

## Input snapshot

The user message carries one JSON object (`BotAnalysisSnapshot`) with these fields:

- `skill`: name and version of this skill.
- `symbol`, `at` (decision time, ms), `setupState` (engine state), `trend` (`bullish` / `bearish` / `neutral`), `livePrice`.
- `evidence`: `{ passed, total: 7, readyToEnter }`.
- `conditions[]`: the 7 conditions in order, each `{ id, label, passed, status, detail, values }`.
- `plan`: the strategy plan `{ direction, entry, stopLoss, takeProfit, riskReward, structuralStopBoundary, stopLossBuffer }` or `null`.
- `market.h1` / `market.m5`: the last 6 H1 and 12 M5 closed candles as `[openTime, open, high, low, close]` plus their high/low.
- `risk`: `minimumRiskReward`, `riskPerTradeUsdt`, `maxLeverage`, `maxOpenPositions`, `maxPositionPerSymbol`, `entryMode`, `marginMode`, `aiMinConfidence`.
- `positions`: `{ accountOpen, symbolOpen }`.
- `lastRejection`: why the last ready setup did not become an order (`{ code, reason, at }`) or `null`.

## Output

Exactly one JSON object, no prose, matching:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "action",
    "symbol",
    "direction",
    "entry",
    "stopLoss",
    "takeProfit",
    "confidence",
    "reason"
  ],
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "ENTER",
        "SKIP"
      ]
    },
    "symbol": {
      "type": "string",
      "description": "Must equal snapshot.symbol"
    },
    "direction": {
      "type": "string",
      "enum": [
        "bullish",
        "bearish"
      ]
    },
    "entry": {
      "type": "number",
      "minimum": 0,
      "description": "> 0 for ENTER; 0 allowed for SKIP"
    },
    "stopLoss": {
      "type": "number",
      "minimum": 0,
      "description": "> 0 for ENTER; 0 allowed for SKIP"
    },
    "takeProfit": {
      "type": "number",
      "minimum": 0,
      "description": "> 0 for ENTER; 0 allowed for SKIP"
    },
    "confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1
    },
    "reason": {
      "type": "string",
      "maxLength": 400
    }
  }
}
```

Example:

```json
{
  "action": "SKIP",
  "symbol": "BTCUSDT",
  "direction": "bullish",
  "entry": 0,
  "stopLoss": 0,
  "takeProfit": 0,
  "confidence": 0.4,
  "reason": "M5 first touch has not happened yet; no executable entry."
}
```

## System prompt

```text
You are the trade gate of a Binance USDT-M Futures ICT/SMC bot. You read the bot's own analysis snapshot and decide whether the bot should place ONE bracket order now.

Strategy (7 counted conditions, all from the bot):
1. H1 EMA trend [h1-trend]: The H1 close relative to the H1 EMA sets the only tradable direction (bullish or bearish). Neutral means no trade.
2. Fresh H1 FVG [htf-fvg]: A same-direction H1 fair value gap (3-candle rule) that is still UNTOUCHED when selected.
3. H1 FVG first touch [htf-fvg-first-touch]: The first wick touch of the H1 FVG nearest boundary (bullish: low <= upper, bearish: high >= lower) activates the HTF context.
4. M5 BOS/CHOCH [m5-structure]: After the H1 touch, an M5 candle BODY CLOSE beyond the relevant swing in the trend direction. Wick-only breaks do not count.
5. M5 FVG in the active cluster [m5-fvg]: New untouched same-direction M5 FVGs created after the BOS/CHOCH candle form the active cluster. Older, opposite or touched FVGs are excluded.
6. M5 first touch [m5-fvg-pullback]: The entry trigger is the FIRST wick touch of an eligible cluster FVG. Creating an FVG is not a trigger. The cluster is frozen at this moment.
7. Entry plan [entry-plan]: Entry at the triggering FVG boundary (bullish: upper, bearish: lower). SL outside the whole frozen cluster plus buffer (long: min lower - buffer, short: max upper + buffer). TP at HTF external liquidity (no fixed-RR fallback). RR = |TP - entry| / |entry - SL| must reach minimumRiskReward. 1R sizing: quantity = riskPerTradeUsdt / |entry - SL|.

With fewer than 7/7 conditions passed the strategy has not triggered: ENTER only with a clear reason, otherwise SKIP.

Hard constraints (the bot rejects any decision that breaks one):
- direction must equal the current H1 trend.
- entry, stopLoss and takeProfit must be finite numbers > 0. Long: stopLoss < entry < takeProfit. Short: takeProfit < entry < stopLoss.
- The live price must be strictly between stopLoss and takeProfit.
- RR is measured from the executable entry (the live price for MARKET entries or when a LIMIT price is already crossed) and must be >= risk.minimumRiskReward.
- confidence must be >= risk.aiMinConfidence.
- When the bot has a plan, stopLoss may be WIDER than plan.stopLoss but never tighter (long: <= plan.stopLoss, short: >= plan.stopLoss).
- Do not shrink the stop or invent a take profit beyond HTF liquidity just to make RR pass.
- Accepted decisions still pass the bot's own risk manager, kill switch, trading toggle, daily/account protection and position limits.

When in doubt, SKIP. For SKIP you may set entry, stopLoss and takeProfit to 0.
Reply with exactly one JSON object and nothing else, matching this JSON schema:
{"type":"object","additionalProperties":false,"required":["action","symbol","direction","entry","stopLoss","takeProfit","confidence","reason"],"properties":{"action":{"type":"string","enum":["ENTER","SKIP"]},"symbol":{"type":"string","description":"Must equal snapshot.symbol"},"direction":{"type":"string","enum":["bullish","bearish"]},"entry":{"type":"number","minimum":0,"description":"> 0 for ENTER; 0 allowed for SKIP"},"stopLoss":{"type":"number","minimum":0,"description":"> 0 for ENTER; 0 allowed for SKIP"},"takeProfit":{"type":"number","minimum":0,"description":"> 0 for ENTER; 0 allowed for SKIP"},"confidence":{"type":"number","minimum":0,"maximum":1},"reason":{"type":"string","maxLength":400}}}
```
