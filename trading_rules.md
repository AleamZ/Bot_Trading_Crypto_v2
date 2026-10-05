CORE BOT WORKFLOW - BINANCE FUTURES ICT/SMC

This document is the source of truth for the bot strategy, risk sizing, and execution flow.

## Core Strategy Flow

```text
H1 EMA direction
-> fresh UNTOUCHED H1 FVG
-> FIRST TOUCH of H1 FVG nearest boundary
-> M5 BOS/CHOCH close break
-> collect new same-direction UNTOUCHED M5 FVGs
-> FIRST TOUCH of an eligible M5 FVG
-> freeze active LTF FVG cluster
-> Entry
-> SL outside entire frozen LTF FVG cluster + buffer
-> TP at HTF external liquidity
-> Minimum R/R validation
-> 1R risk-based sizing
-> margin/leverage/Binance validation
-> execution
```

## FVG Lifecycle

FVG detection keeps the existing 3-candle rule.

An FVG is `UNTOUCHED` after it is confirmed by the third candle.

Only candles after the confirmation candle can change its lifecycle.

An FVG becomes `TOUCHED` the first time a subsequent candle wick reaches the nearest boundary:

- Bullish FVG: `candle.low <= fvg.upper`
- Bearish FVG: `candle.high >= fvg.lower`

Boundary equality counts as touch.

The FVG creation candles never self-mark the FVG as touched.

Once touched, an FVG never becomes untouched again.

There is no Edge / CE / Full entry eligibility mode. First touch is mandatory.

## HTF H1 Context

HTF uses H1.

Required:

- H1 EMA confirms direction.
- A same-direction H1 FVG exists.
- The H1 FVG is fresh and untouched.
- The first touch of that H1 FVG activates HTF context.

Historical FVGs already touched before the current runtime evaluation are not eligible as fresh HTF setup candidates.

First touch of the selected H1 FVG is detected on the first M5 candle that reaches its nearest boundary (it does not wait for the H1 close). An M5 candle that closes through the whole H1 FVG is a break, not a reaction, and does not activate it; H1 close still decides invalidation.

Once activated, the HTF context stays active for at most 12 hours (`HTF_CONTEXT_MAX_AGE_MS`). It ends early on H1 invalidation, an H1 trend flip, or when a newer same-direction H1 FVG forms after the touch while no M5 BOS/CHOCH has happened yet. Other, older fresh H1 FVGs never reset an active LTF setup.

After a restart, bootstrap replays both H1 and M5 history without placing orders, so an in-progress setup is rebuilt. A touched H1 FVG is adopted on restart only while its 12-hour window is still open. A trigger found in replayed history is archived (`HISTORICAL_TRIGGER`).

## M5 Structure

After HTF first touch, the bot waits for M5 BOS/CHOCH.

BOS/CHOCH still requires candle close beyond the relevant swing.

Wick-only structure breaks do not count.

The optional displacement filter may reject weak BOS/CHOCH candles. If the filter is OFF, Body Multiplier and Body Lookback do not affect the strategy.

## Active LTF FVG Cluster

After an accepted M5 BOS/CHOCH, the bot starts one active setup cycle.

An FVG belongs to the active LTF cluster only if all are true:

- timeframe is M5
- direction matches the setup
- created after the BOS/CHOCH candle
- still untouched before the entry-triggering first touch
- created before the entry plan is frozen
- belongs to the same setup cycle

The cluster excludes old FVGs, opposite-direction FVGs, HTF FVGs, already touched FVGs, and FVGs created after freeze.

## Entry Trigger

The bot does not enter when an M5 FVG is created.

It waits until price first touches an eligible FVG in the active cluster.

At that first touch:

- mark the triggering FVG as touched
- keep the triggering FVG inside the frozen protective cluster
- freeze the full active cluster snapshot
- calculate entry, SL, TP, R/R, and risk sizing

The same first-touch event must be idempotent and must not create duplicate execution intents.

Every cluster FVG reached by the trigger candle becomes touched. A failed entry attempt never re-triggers on a later (second) touch.

If the trigger candle closes beyond the cluster stop loss, the setup is archived (`TRIGGER_CLOSED_BEYOND_STOP`).

## Entry, Stop Loss, Take Profit

Entry:

- Bullish: triggering FVG upper boundary
- Bearish: triggering FVG lower boundary

Cluster stop boundary:

- Long: `MIN(lowerBoundary of every FVG in frozen cluster)`
- Short: `MAX(upperBoundary of every FVG in frozen cluster)`

Final stop loss:

- Long: `clusterBoundary - buffer`
- Short: `clusterBoundary + buffer`

Buffer modes:

- Ticks: uses Binance symbol-specific `tickSize`
- Percentage: applies after cluster boundary is calculated
- ATR: applies after cluster boundary is calculated

Take profit:

- Long: HTF buy-side liquidity
- Short: HTF sell-side liquidity

No Fixed RR TP fallback is allowed.

## Minimum R/R

After entry, cluster SL, and HTF liquidity TP are known:

```text
riskDistance = abs(entry - stopLoss)
rewardDistance = abs(takeProfit - entry)
RR = rewardDistance / riskDistance
```

If RR is below the configured minimum, reject the setup with the existing RR rejection path.

The bot must not shrink SL or move TP to make RR pass.

## Execution Price

The plan above is the strategy plan. Before risk sizing the bot reads the live price:

- If the live price is at/beyond SL or TP, the entry is skipped (`PRICE_BEYOND_PROTECTION`).
- MARKET entry: entry = live price. RR and 1R quantity are computed from the live price.
- LIMIT entry: entry = FVG boundary, unless price already crossed it, in which case entry = live price.

A ready setup is only entered on its trigger candle. If it is blocked (risk gate, trading disabled, order error) it is shown as `Blocked: <code>` and archived on the next M5 close (`ENTRY_WINDOW_EXPIRED`). It is never entered late.

## Protection Orders

- SL and TP are `STOP_MARKET` / `TAKE_PROFIT_MARKET` with `closePosition=true`, so they always exit the real position size.
- The gateway re-checks the live price right before the entry and refuses if it is outside SL/TP.
- If the SL cannot be placed after a MARKET fill, the position is closed immediately (`PROTECTION_FAILED_POSITION_CLOSED`).
- If only the TP fails, the SL protects the position and reconciliation repairs the TP.
- A LIMIT entry gets SL/TP only after it fills (via reconciliation). An unfilled LIMIT entry is cancelled after 15 minutes. While it rests, the symbol counts as occupied.
- A repair that fails because the trigger price is already crossed (Binance -2021) closes the position immediately instead of retrying.

## 1R Risk-Based Sizing

Risk per Trade (1R) is the target monetary risk.

After final cluster SL:

```text
rawQuantity = riskPerTradeUsdt / abs(entry - stopLoss)
quantity = Binance stepSize-normalized rawQuantity
actualRisk = abs(entry - stopLoss) * quantity
```

A wider cluster SL produces a smaller quantity for the same 1R.

The bot must preserve Binance symbol filters, max leverage, max margin usage, minQty, maxQty, minNotional, tickSize, stepSize, and supported order type validation.

## Protection Gates

Daily protection:

- Daily Profit Limit (R)
- Daily Loss Limit (R)
- based on account-scoped bot-owned realized R
- blocks new entries only

Account protection:

- Max Drawdown %
- account-scoped equity peak protection
- blocks new entries only

Concurrency:

- Max Open Positions limits simultaneous account positions only
- Max Position Per Symbol remains locked at 1

Margin mode:

- ISOLATED: liquidation price is estimated from the position's own margin.
- CROSS: the isolated estimate is used as a safe lower bound, but only while no other position shares the cross collateral; otherwise new entries are blocked.

## REAL Execution

REAL execution remains locked by project policy unless the explicit existing safety controls allow proposal-only behavior.

This strategy document does not unlock live Mainnet order submission.
