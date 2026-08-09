export async function fetchCandles({ symbol, interval, limit }) {
  const response = await fetch(
    `/api/binance/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
  );
  if (!response.ok) throw new Error(`Candles request failed: ${response.status}`);
  return response.json();
}

export async function fetchOverlays({ symbol, interval, limit }) {
  const response = await fetch(
    `/api/chart/overlays?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(interval)}&limit=${limit}`,
  );
  if (!response.ok) throw new Error(`Overlays request failed: ${response.status}`);
  return response.json();
}
