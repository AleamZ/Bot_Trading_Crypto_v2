import { apiFetch } from "../../apiClient.js";

export async function fetchCandles({ symbol, interval, limit }) {
  const response = await apiFetch(
    `/api/binance/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
  );
  if (!response.ok) throw new Error(`Candles request failed: ${response.status}`);
  return response.json();
}

export async function fetchOverlays({ accountId, symbol, interval, limit }) {
  if (!accountId) throw new Error("Trading account is required for chart overlays");
  const response = await apiFetch(
    `/api/trading-accounts/${accountId}/chart/overlays?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(interval)}&limit=${limit}`,
  );
  if (!response.ok) throw new Error(`Overlays request failed: ${response.status}`);
  return response.json();
}

export async function fetchAccountActivity({ accountId, symbol, limit }) {
  if (!accountId) throw new Error("Trading account is required for account activity");
  const query = new URLSearchParams({ limit: String(limit) });
  if (symbol) query.set("symbol", symbol);
  const response = await apiFetch(
    `/api/trading-accounts/${accountId}/chart/account-activity?${query.toString()}`,
  );
  if (!response.ok) throw new Error(`Account activity request failed: ${response.status}`);
  return response.json();
}
