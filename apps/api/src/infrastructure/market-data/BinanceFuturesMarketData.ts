import type { Candle, Timeframe } from "../../domain/market-data/Candle.js";

const intervalByTimeframe: Record<Timeframe, string> = {
  M1: "1m",
  M5: "5m",
  M15: "15m",
  H1: "1h",
  H4: "4h",
  D1: "1d"
};

export interface BinanceKline {
  time: number;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface BinanceFuturesSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
}

export class BinanceFuturesMarketData {
  private symbolsCache: { expiresAt: number; symbols: BinanceFuturesSymbol[] } | null = null;

  constructor(private readonly testnet: boolean) {}

  async getClosedCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const baseUrl = this.testnet ? "https://demo-fapi.binance.com" : "https://fapi.binance.com";
    const url = new URL("/fapi/v1/klines", baseUrl);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", intervalByTimeframe[timeframe]);
    url.searchParams.set("limit", String(limit));

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Binance klines failed ${response.status}: ${await response.text()}`);
    }

    const rows = (await response.json()) as unknown[][];
    const now = Date.now();
    return rows
      .map((row) => toCandle(symbol, timeframe, row))
      .filter((candle) => candle.closeTime <= now && candle.isClosed);
  }

  async getKlines(symbol: string, interval: string, limit: number): Promise<BinanceKline[]> {
    const baseUrl = this.testnet ? "https://demo-fapi.binance.com" : "https://fapi.binance.com";
    const url = new URL("/fapi/v1/klines", baseUrl);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Binance klines failed ${response.status}: ${await response.text()}`);
    }

    const rows = (await response.json()) as unknown[][];
    return rows.map(toKline);
  }

  async getFuturesSymbols(): Promise<BinanceFuturesSymbol[]> {
    const now = Date.now();
    if (this.symbolsCache && this.symbolsCache.expiresAt > now) {
      return this.symbolsCache.symbols;
    }

    const baseUrl = this.testnet ? "https://demo-fapi.binance.com" : "https://fapi.binance.com";
    const url = new URL("/fapi/v1/exchangeInfo", baseUrl);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Binance exchangeInfo failed ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as BinanceExchangeInfo;
    const symbols = (body.symbols ?? [])
      .filter((symbol) => symbol.status === "TRADING")
      .map((symbol) => ({
        symbol: symbol.symbol,
        baseAsset: symbol.baseAsset,
        quoteAsset: symbol.quoteAsset,
        status: symbol.status
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));

    this.symbolsCache = { expiresAt: now + 5 * 60_000, symbols };
    return symbols;
  }
}

interface BinanceExchangeInfo {
  symbols?: Array<{
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    status: string;
  }>;
}

function toKline(row: unknown[]): BinanceKline {
  const openTime = numberAt(row, 0);
  return {
    time: Math.floor(openTime / 1000),
    openTime,
    open: parseNumberAt(row, 1),
    high: parseNumberAt(row, 2),
    low: parseNumberAt(row, 3),
    close: parseNumberAt(row, 4),
    volume: parseNumberAt(row, 5),
    closeTime: numberAt(row, 6)
  };
}

function toCandle(symbol: string, timeframe: Timeframe, row: unknown[]): Candle {
  const openTime = numberAt(row, 0);
  const closeTime = numberAt(row, 6);
  return {
    symbol,
    timeframe,
    openTime,
    closeTime,
    open: parseNumberAt(row, 1),
    high: parseNumberAt(row, 2),
    low: parseNumberAt(row, 3),
    close: parseNumberAt(row, 4),
    volume: parseNumberAt(row, 5),
    isClosed: closeTime < Date.now()
  };
}

function numberAt(row: unknown[], index: number): number {
  const value = row[index];
  if (typeof value !== "number") throw new Error(`Expected numeric kline field at ${index}`);
  return value;
}

function parseNumberAt(row: unknown[], index: number): number {
  const value = row[index];
  if (typeof value !== "string") throw new Error(`Expected string kline field at ${index}`);
  return Number(value);
}
