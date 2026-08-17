#!/usr/bin/env bash

set -euo pipefail

APP_NAME="${APP_NAME:-smc-futures-api}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/health/ready}"

echo "==> Pulling latest code..."
git pull

echo "==> Installing dependencies..."
npm ci

echo "==> Typechecking..."
npm run typecheck

echo "==> Running tests..."
npm test

echo "==> Building..."
npm run build

echo "==> Restarting API..."
pm2 restart "$APP_NAME" --update-env

echo "==> Checking PM2..."
pm2 status

echo "==> Waiting for readiness..."
for attempt in {1..30}; do
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    echo "==> API is ready"
    echo "==> Deploy completed successfully!"
    exit 0
  fi
  sleep 2
done

echo "API did not become ready: $HEALTH_URL" >&2
exit 1
