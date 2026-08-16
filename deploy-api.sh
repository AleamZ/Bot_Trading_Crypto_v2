#!/bin/bash

set -e

echo "==> Pulling latest code..."
git pull

echo "==> Installing dependencies..."
npm ci

echo "==> Building API..."
npm run build:api

echo "==> Restarting API..."
pm2 restart binance-api

echo "==> Checking PM2..."
pm2 status

echo "==> Checking API..."
curl -f http://127.0.0.1:8787/api/settings

echo "==> Deploy completed successfully!"