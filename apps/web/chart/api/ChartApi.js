import { apiFetch } from "../../apiClient.js";

export async function fetchCandles({ symbol, interval, limit }) {
  const response = await apiFetch(
    `/api/binance/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
  );
  if (!response.ok) throw new Error(`Candles request failed: ${response.status}`);
  return response.json();
}

export async function fetchOverlays({ symbol, interval, limit }) {
  const response = await apiFetch(
    `/api/chart/overlays?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(interval)}&limit=${limit}`,
  );
  if (!response.ok) throw new Error(`Overlays request failed: ${response.status}`);
  return response.json();
}

export async function fetchAccountActivity({ symbol, limit }) {
  const response = await apiFetch(
    `/api/binance/account-activity?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  );
  if (!response.ok) throw new Error(`Account activity request failed: ${response.status}`);
  return response.json();
}
