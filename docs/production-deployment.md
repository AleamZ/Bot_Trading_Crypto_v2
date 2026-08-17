# Production Deployment

## Architecture

Production runs as one active backend bot process:

Vercel frontend -> HTTPS API domain on VPS -> Node API on `127.0.0.1:8787` -> Supabase/PostgreSQL -> Binance Futures.

`DEMO` uses Binance Futures Testnet. `REAL` may read Mainnet account data, but automatic execution remains locked.

## Required Backend Environment

Set these on the VPS only:

```bash
NODE_ENV=production
PORT=8787
DATABASE_URL=postgres://...
POSTGRES_POOL_MAX=2
SESSION_SECRET=change-me-at-least-32-characters
BINANCE_CREDENTIAL_ENCRYPTION_KEY=<openssl rand -hex 32>
CORS_ORIGINS=https://your-vercel-domain.vercel.app
RECONCILIATION_INTERVAL_MS=30000
BINANCE_RETRY_MAX_ATTEMPTS=3
BINANCE_RETRY_BASE_DELAY_MS=500
```

Do not set or require legacy `BINANCE_API_KEY` / `BINANCE_API_SECRET` for multi-user production.

## Startup Lifecycle

1. Validate production environment.
2. Initialize structured logger.
3. Initialize shared PostgreSQL pool.
4. Run idempotent schema migrations.
5. Start HTTP server.
6. Load trading accounts.
7. Account runtimes enter `RECOVERING`.
8. Reconcile Binance state.
9. Runtime becomes `READY`.
10. Scanner loops start.

Execution is blocked until runtime health is `READY`. During shutdown it is blocked by `SHUTTING_DOWN`.

## Process Manager

Use PM2 in fork mode with exactly one instance:

```bash
npm ci
npm run typecheck
npm test
npm run build
sudo mkdir -p /var/log/smc-futures-api
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Do not use PM2 cluster mode or multiple backend replicas. Runtime ownership, scanners, and reconciliation are process-local; multiple active workers could duplicate execution.

## Deploy

Use:

```bash
./deploy-api.sh
```

The script pulls code, installs dependencies, runs typecheck/tests/build, restarts PM2 only after success, and waits for `/health/ready`.

## Nginx / HTTPS

Recommended topology:

```nginx
server {
  listen 443 ssl http2;
  server_name api.example.com;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-Id $request_id;
  }
}
```

Use a normal ACME/Let’s Encrypt setup for TLS. Do not expose raw `http://<ip>:8787` to Vercel production.

## Vercel Frontend

Use runtime config in `apps/web/config.js`:

```js
window.__APP_CONFIG__ = {
  API_BASE_URL: "https://api.example.com"
};
```

Only public-safe frontend config belongs on Vercel. Backend secrets stay on the VPS.

Cookies are `HttpOnly`, `Secure`, and `SameSite=None` in production for cross-site Vercel/API usage. Fetch uses `credentials: "include"`, and backend CORS allows credentials only for configured `CORS_ORIGINS`.

## Health And Operations

Public:

- `GET /health/live`
- `GET /health/ready`

Authenticated:

- `GET /api/system/status`

Readiness checks DB reachability and bootstrap completion, but does not require every user Binance account to be connected.

## Secrets And Rotation

Never commit `.env`, print secrets, send secrets to frontend, or log secret values.

Rotation:

- `SESSION_SECRET`: planned rotation logs out active sessions.
- `DATABASE_URL`: update DB credentials and VPS environment, then restart.
- `BINANCE_CREDENTIAL_ENCRYPTION_KEY`: do not rotate casually. Existing encrypted Binance credentials become unreadable unless re-encrypted with a planned migration.

## Logs And Rotation

Production logs are JSON and include timestamp, level, component, message, and request/runtime context when available. Secret-like fields are redacted as `configured`.

For PM2 logs:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
```

Alternatively, use system logrotate for `/var/log/smc-futures-api/*.log`.

## Database Pool

Supabase session pool limits are conservative. The API uses one shared PostgreSQL pool per `DATABASE_URL`; default `POSTGRES_POOL_MAX=2`. Do not create per-runtime pools.

Use the Supabase pooler endpoint recommended for long-running Node services. If using session mode, keep pool size low. Do not switch to transaction mode blindly without testing prepared/session behavior.

## Backups

Use Supabase managed backups or scheduled `pg_dump` for:

- `users`
- `user_sessions`
- `trading_accounts`
- `binance_connections`
- `trading_settings`
- `trading_watchlist_symbols`
- `execution_intents`
- `execution_audit_events`
- `trading_records`
- `schema_migrations`

Restore drill:

1. Restore to a staging database.
2. Start backend with staging env.
3. Verify `/health/ready`.
4. Login with a test user.
5. Verify account-scoped snapshot and reconciliation.
6. Confirm REAL execution remains locked.

## Audit Retention

`execution_audit_events` grows over time. Keep at least 90 days online for operational debugging, then archive or delete older rows during a maintenance window. External position detection is throttled to reduce repeated identical audit spam.

## VPS Reboot

After reboot PM2 should start the single backend process. The backend validates env, runs idempotent migrations, enters `RECOVERING`, reconciles, and reaches `READY`. Disabled trading settings remain disabled.

Suggested minimum VPS: one small Node-capable VPS with stable RAM and disk, plus log rotation enabled. Monitor disk usage, memory, and PM2 restarts.
