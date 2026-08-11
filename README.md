# Binance USDT-M Futures SMC Bot

TypeScript SMC Futures bot split into a deployable frontend and a persistent backend.

## Architecture

```text
Browser
  |
  | HTTPS
  v
Frontend (apps/web, Vercel/static)
  |
  | REST API
  v
Backend (apps/api, persistent Node.js)
  |
  +--> MarketScanner
  +--> per-symbol TradingEngine
  +--> RiskManager
  +--> Binance Futures
  +--> PostgreSQL/Supabase
```

The frontend is vanilla HTML/CSS/JS and only renders UI. It does not contain Binance secrets, database URLs, MarketScanner, TradingEngine, or order execution logic.

The backend owns the bot runtime: settings, watchlist, scanner, strategy lifecycle, risk checks, Binance clients, execution gateways, and persistence.

## Local Development

Install once from the repo root:

```bash
npm install
```

Run the backend:

```bash
npm run dev:api
```

Run the frontend in another terminal:

```bash
npm run dev:web
```

Defaults:

- Backend API: `http://localhost:8787`
- Frontend UI: `http://localhost:5173`

The backend starts MarketScanner automatically. The bot does not require the browser to be open.

## Environment

Backend env belongs in root `.env` or `apps/api/.env`:

```bash
NODE_ENV=development
PORT=8787
EXECUTION_MODE=paper
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_TESTNET=true
DATABASE_URL=
LOG_LEVEL=info
CORS_ORIGINS=http://localhost:5173
DEFAULT_WATCHLIST=BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT
```

Frontend env is public only:

```bash
VITE_API_BASE_URL=http://localhost:8787
```

Never put `BINANCE_API_SECRET`, `BINANCE_API_KEY`, or `DATABASE_URL` in frontend env.

## API

Core backend routes:

- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/watchlist`
- `PUT /api/watchlist`
- `GET /api/watchlist/status`
- `GET /api/analysis?symbol=BTCUSDT`
- `GET /api/market/symbols`
- `GET /api/binance/klines`
- `GET /api/chart/overlays`
- `GET /api/binance/account-activity`

Frontend requests go through `VITE_API_BASE_URL` generated into `apps/web/app-config.js` during dev/build.

## Build And Test

From the repo root:

```bash
npm run typecheck
npm test
npm run build
```

Or separately:

```bash
npm run build:api
npm run build:web
```

## Deploy

Frontend:

- Deploy `apps/web` to Vercel as a static project.
- Set `VITE_API_BASE_URL=https://<backend-domain>`.
- Build command: `npm run build:web` from root, or `npm run build` inside `apps/web`.
- Output directory: `apps/web/dist`.

Backend:

- Deploy `apps/api` to a persistent Node server such as VPS, Railway, Render, or Fly.io.
- Set backend env values, including Binance credentials, database URL, execution mode, and `CORS_ORIGINS=https://<frontend-domain>`.
- Start command: `npm run start:api` from root, or `npm start` inside `apps/api` after build.

Database:

- PostgreSQL/Supabase is accessed only by the backend.

## Strategy Boundary

This architecture refactor does not change strategy logic:

- EMA trend
- FVG rules
- BOS/CHOCH
- HTF/LTF workflow
- Entry, SL, TP
- RR filtering
- Risk management behavior
- MarketScanner/TradingEngine lifecycle

