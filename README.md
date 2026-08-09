# Binance USDT-M Futures SMC Bot

Production-oriented TypeScript scaffold for one deterministic SMC workflow described by `trading_rules.md`.

## Run

```bash
npm install
npm run typecheck
npm test
npm run dev
```

Dashboard: `http://localhost:8787`

## Boundaries

- Binance USDT-M Futures only.
- One strategy only.
- No AI/ML, no signal voting, no multi-exchange logic.
- Trading logic lives in `src/domain`.
- Frontend is read-only and displays state from the HTTP adapter.

Rules that are optional in `trading_rules.md` are exposed as config, with deterministic defaults:

- Execution mode: `testnet` or `live`
- FVG mitigation: `ce`
- Stop loss: `ltf-swing`
- Take profit: `external-liquidity`
