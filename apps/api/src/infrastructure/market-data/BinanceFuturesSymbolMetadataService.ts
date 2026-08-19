import type { FuturesSymbolRules } from "../../domain/symbol/SymbolRules.js";
import type { BinanceFuturesLeverageBracket } from "../execution/BinanceFuturesAccountClient.js";

type Environment = "testnet" | "live";

export class BinanceFuturesSymbolMetadataService {
  private readonly cache = new Map<string, { expiresAt: number; rules: FuturesSymbolRules }>();

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly ttlMs = 10 * 60_000
  ) {}

  async getSymbolRules(
    symbol: string,
    environment: Environment,
    loadLeverageBrackets?: () => Promise<BinanceFuturesLeverageBracket[]>
  ): Promise<FuturesSymbolRules> {
    const key = `${environment}:${symbol}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return withMaxLeverage(cached.rules, await readMaxLeverage(symbol, loadLeverageBrackets));
    }

    const baseUrl = environment === "testnet" ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
    const url = new URL("/fapi/v1/exchangeInfo", baseUrl);
    url.searchParams.set("symbol", symbol);
    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`Binance exchangeInfo failed ${response.status}: ${(await response.text()).slice(0, 180)}`);
    const body = (await response.json()) as BinanceExchangeInfo;
    const info = body.symbols?.find((item) => item.symbol === symbol);
    if (!info) throw new Error("SYMBOL_RULES_UNAVAILABLE");
    const rules = parseSymbolRules(info);
    this.cache.set(key, { expiresAt: Date.now() + this.ttlMs, rules });
    return withMaxLeverage(rules, await readMaxLeverage(symbol, loadLeverageBrackets));
  }
}

interface BinanceExchangeInfo {
  symbols?: BinanceSymbolInfo[];
}

interface BinanceSymbolInfo {
  symbol: string;
  status?: string;
  contractType?: string;
  quoteAsset?: string;
  marginAsset?: string;
  pricePrecision?: number;
  quantityPrecision?: number;
  orderTypes?: string[];
  filters: Array<{
    filterType: string;
    minPrice?: string;
    maxPrice?: string;
    tickSize?: string;
    minQty?: string;
    maxQty?: string;
    stepSize?: string;
    notional?: string;
  }>;
}

function parseSymbolRules(info: BinanceSymbolInfo): FuturesSymbolRules {
  const lotSize = info.filters.find((filter) => filter.filterType === "LOT_SIZE");
  const price = info.filters.find((filter) => filter.filterType === "PRICE_FILTER");
  const minNotional = info.filters.find((filter) => filter.filterType === "MIN_NOTIONAL");
  return {
    symbol: info.symbol,
    status: info.status ?? "UNKNOWN",
    contractType: info.contractType ?? null,
    quoteAsset: info.quoteAsset ?? null,
    marginAsset: info.marginAsset ?? null,
    pricePrecision: numberOrNull(info.pricePrecision),
    quantityPrecision: numberOrNull(info.quantityPrecision),
    tickSize: Number(price?.tickSize ?? 0),
    minPrice: numberOrNull(price?.minPrice),
    maxPrice: numberOrNull(price?.maxPrice),
    stepSize: Number(lotSize?.stepSize ?? 0),
    minQty: Number(lotSize?.minQty ?? 0),
    maxQty: numberOrNull(lotSize?.maxQty),
    minNotional: numberOrNull(minNotional?.notional),
    maxLeverage: null,
    supportedOrderTypes: info.orderTypes ?? []
  };
}

async function readMaxLeverage(symbol: string, loadLeverageBrackets: (() => Promise<BinanceFuturesLeverageBracket[]>) | undefined): Promise<number | null> {
  if (!loadLeverageBrackets) return null;
  try {
    const brackets = await loadLeverageBrackets();
    return brackets.find((item) => item.symbol === symbol)?.maxInitialLeverage ?? null;
  } catch {
    return null;
  }
}

function withMaxLeverage(rules: FuturesSymbolRules, maxLeverage: number | null): FuturesSymbolRules {
  return { ...rules, maxLeverage };
}

function numberOrNull(value: string | number | undefined): number | null {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : null;
}
