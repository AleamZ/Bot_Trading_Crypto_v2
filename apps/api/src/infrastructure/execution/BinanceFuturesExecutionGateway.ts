import crypto from "node:crypto";
import type {
  ExecutionOrderContext,
  ExecutionOrderLookupResult,
  ProtectionOrderRequest,
  RecoverableExecutionGateway,
  SubmittedOrder
} from "../../application/ports/ExecutionGateway.js";
import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";
import { formatRuleNumber, normalizePrice, normalizeQuantity, validateAgainstSymbolRules, type FuturesSymbolRules } from "../../domain/symbol/SymbolRules.js";
import { PostEntryProtectionError } from "../../application/execution/PostEntryProtectionError.js";

type BinanceOrderSide = "BUY" | "SELL";
type EntryMode = "limit" | "market";

export class BinanceFuturesExecutionGateway implements RecoverableExecutionGateway {
  private readonly baseUrl: string;
  private readonly symbolRules = new Map<string, FuturesSymbolRules>();
  private readonly marketPrices = new Map<string, { expiresAt: number; price: number }>();

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly mode: "testnet" | "live",
    private readonly entryMode: EntryMode,
    private readonly leverage: number
  ) {
    this.baseUrl = mode === "testnet" ? "https://demo-fapi.binance.com" : "https://fapi.binance.com";
  }

  async submitBracketOrder(plan: EntryPlan, risk: RiskDecision, context?: ExecutionOrderContext): Promise<SubmittedOrder> {
    const symbol = risk.symbol;
    const rules = await this.getSymbolRules(symbol);
    const entryOrderType = this.entryMode.toUpperCase();
    const validation = validateAgainstSymbolRules(rules, {
      symbol,
      orderType: entryOrderType,
      quantity: risk.quantity,
      price: this.entryMode === "limit" ? plan.entry : null,
      notional: risk.notional,
      leverage: risk.leverage
    });
    if (!validation.ok) throw new Error(validation.reason ?? "SYMBOL_RULE_VALIDATION_FAILED");
    const quantity = formatRuleNumber(validation.normalized.quantity);
    if (this.entryMode === "market") {
      await this.validateMarketOrderNotional(symbol, validation.normalized.quantity, rules);
    }

    await this.setLeverage(symbol, risk.leverage);

    const entrySide = plan.direction === "bullish" ? "BUY" : "SELL";
    const exitSide = oppositeSide(entrySide);
    const entry = await this.submitEntryOrder(symbol, entrySide, quantity, formatRuleNumber(normalizePrice(plan.entry, rules.tickSize)), context?.clientEntryOrderId);
    const partialOrder = (): SubmittedOrder => ({
      orderId: String(entry.orderId),
      ...(context?.clientEntryOrderId ? { clientEntryOrderId: context.clientEntryOrderId } : {}),
      ...(context?.clientStopOrderId ? { clientStopOrderId: context.clientStopOrderId } : {}),
      ...(context?.clientTakeProfitOrderId ? { clientTakeProfitOrderId: context.clientTakeProfitOrderId } : {}),
      mode: this.mode
    });

    let stopLoss: BinanceAlgoOrderResponse;
    try {
      stopLoss = await this.submitAlgoTriggerOrder(symbol, "STOP_MARKET", exitSide, quantity, formatRuleNumber(normalizePrice(plan.stopLoss, rules.tickSize)), context?.clientStopOrderId);
    } catch (error) {
      throw new PostEntryProtectionError(error instanceof Error ? error.message : String(error), partialOrder());
    }

    let takeProfit: BinanceAlgoOrderResponse;
    try {
      takeProfit = await this.submitAlgoTriggerOrder(symbol, "TAKE_PROFIT_MARKET", exitSide, quantity, formatRuleNumber(normalizePrice(plan.takeProfit, rules.tickSize)), context?.clientTakeProfitOrderId);
    } catch (error) {
      throw new PostEntryProtectionError(error instanceof Error ? error.message : String(error), {
        ...partialOrder(),
        stopLossOrderId: String(stopLoss.algoId)
      });
    }

    return {
      orderId: String(entry.orderId),
      stopLossOrderId: String(stopLoss.algoId),
      takeProfitOrderId: String(takeProfit.algoId),
      ...(context?.clientEntryOrderId ? { clientEntryOrderId: context.clientEntryOrderId } : {}),
      ...(context?.clientStopOrderId ? { clientStopOrderId: context.clientStopOrderId } : {}),
      ...(context?.clientTakeProfitOrderId ? { clientTakeProfitOrderId: context.clientTakeProfitOrderId } : {}),
      mode: this.mode
    };
  }

  async findOrderByClientOrderId(symbol: string, clientOrderId: string): Promise<ExecutionOrderLookupResult | null> {
    try {
      const order = await this.signedGet<BinanceOrderResponse>("/fapi/v1/order", {
        symbol,
        origClientOrderId: clientOrderId
      });
      return toExecutionOrderLookupResult(order, symbol, clientOrderId);
    } catch (error) {
      if (isOrderNotFound(error)) return null;
      throw error;
    }
  }

  async submitProtectionOrder(request: ProtectionOrderRequest): Promise<ExecutionOrderLookupResult> {
    const rules = await this.getSymbolRules(request.symbol);
    const validation = validateAgainstSymbolRules(rules, {
      symbol: request.symbol,
      orderType: request.type,
      quantity: request.quantity,
      stopPrice: request.stopPrice,
      notional: request.quantity * request.stopPrice,
      leverage: 1
    });
    if (!validation.ok) throw new Error(validation.reason ?? "SYMBOL_RULE_VALIDATION_FAILED");
    const existing = await this.findAlgoOrderByClientAlgoId(request.clientOrderId);
    if (existing) return toExecutionOrderLookupResult(existing, request.symbol, request.clientOrderId);

    const order = await this.submitAlgoTriggerOrder(
      request.symbol,
      request.type,
      request.side,
      formatRuleNumber(validation.normalized.quantity),
      formatRuleNumber(validation.normalized.stopPrice ?? normalizePrice(request.stopPrice, rules.tickSize)),
      request.clientOrderId
    );
    return toExecutionOrderLookupResult(order, request.symbol, request.clientOrderId);
  }

  async cancelOrderByClientOrderId(symbol: string, clientOrderId: string): Promise<void> {
    const params = new URLSearchParams({
      symbol,
      origClientOrderId: clientOrderId,
      timestamp: String(Date.now()),
      recvWindow: "5000"
    });
    try {
      await this.signedDelete("/fapi/v1/order", params, "Binance order cancel failed");
    } catch (error) {
      if (!isOrderNotFound(error)) throw error;
    }
    const algoParams = new URLSearchParams({
      symbol,
      clientAlgoId: clientOrderId,
      timestamp: String(Date.now()),
      recvWindow: "5000"
    });
    try {
      await this.signedDelete("/fapi/v1/algoOrder", algoParams, "Binance algo order cancel failed");
    } catch (error) {
      if (!isOrderNotFound(error)) throw error;
    }
  }

  private async submitEntryOrder(symbol: string, side: BinanceOrderSide, quantity: string, price: string, clientOrderId?: string): Promise<BinanceOrderResponse> {
    const params = new URLSearchParams({
      symbol,
      side,
      type: this.entryMode.toUpperCase(),
      quantity,
      timestamp: String(Date.now())
    });
    if (clientOrderId) params.set("newClientOrderId", clientOrderId);

    if (this.entryMode === "limit") {
      params.set("timeInForce", "GTC");
      params.set("price", price);
    }

    return this.signedPost("/fapi/v1/order", params, "Binance entry order failed");
  }

  private async submitAlgoTriggerOrder(
    symbol: string,
    type: "STOP_MARKET" | "TAKE_PROFIT_MARKET",
    side: BinanceOrderSide,
    quantity: string,
    triggerPrice: string,
    clientOrderId?: string
  ): Promise<BinanceAlgoOrderResponse> {
    const params = new URLSearchParams({
      algoType: "CONDITIONAL",
      symbol,
      side,
      type,
      quantity,
      triggerPrice,
      reduceOnly: "true",
      workingType: "CONTRACT_PRICE",
      timestamp: String(Date.now())
    });
    if (clientOrderId) params.set("clientAlgoId", clientOrderId);

    return this.signedPost("/fapi/v1/algoOrder", params, `Binance ${type} algo order failed`);
  }

  private async setLeverage(symbol: string, leverage: number): Promise<void> {
    const params = new URLSearchParams({
      symbol,
      leverage: String(Math.trunc(leverage)),
      timestamp: String(Date.now())
    });
    await this.signedPost("/fapi/v1/leverage", params, "Binance leverage update failed");
  }

  private async signedPost<T extends BinanceOrderResponse | BinanceAlgoOrderResponse>(path: string, params: URLSearchParams, label: string): Promise<T> {
    params.set("signature", this.sign(params.toString()));
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": this.apiKey },
      body: params
    });

    if (!response.ok) {
      throw new Error(`${label} ${response.status}: ${await response.text()}`);
    }

    return (await response.json()) as T;
  }

  private async signedGet<T>(path: string, queryParams: Record<string, string>): Promise<T> {
    const params = new URLSearchParams({ ...queryParams, timestamp: String(Date.now()), recvWindow: "5000" });
    params.set("signature", this.sign(params.toString()));
    const response = await fetch(`${this.baseUrl}${path}?${params.toString()}`, {
      headers: { "X-MBX-APIKEY": this.apiKey }
    });

    if (!response.ok) {
      throw new Error(`Binance signed GET ${path} failed ${response.status}: ${await response.text()}`);
    }

    return (await response.json()) as T;
  }

  private async signedDelete(path: string, params: URLSearchParams, label: string): Promise<BinanceOrderResponse | BinanceAlgoOrderResponse> {
    params.set("signature", this.sign(params.toString()));
    const response = await fetch(`${this.baseUrl}${path}?${params.toString()}`, {
      method: "DELETE",
      headers: { "X-MBX-APIKEY": this.apiKey }
    });

    if (!response.ok) {
      throw new Error(`${label} ${response.status}: ${await response.text()}`);
    }

    return (await response.json()) as BinanceOrderResponse;
  }

  private sign(payload: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(payload).digest("hex");
  }

  private async getSymbolRules(symbol: string): Promise<FuturesSymbolRules> {
    const cached = this.symbolRules.get(symbol);
    if (cached) return cached;

    const url = new URL("/fapi/v1/exchangeInfo", this.baseUrl);
    url.searchParams.set("symbol", symbol);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Binance exchangeInfo failed ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as BinanceExchangeInfo;
    const symbolInfo = body.symbols?.find((item) => item.symbol === symbol);
    const lotSize = symbolInfo?.filters.find((filter) => filter.filterType === "LOT_SIZE");
    const priceFilter = symbolInfo?.filters.find((filter) => filter.filterType === "PRICE_FILTER");
    const minNotional = symbolInfo?.filters.find((filter) => filter.filterType === "MIN_NOTIONAL");
    const rules: FuturesSymbolRules = {
      symbol,
      status: symbolInfo?.status ?? "UNKNOWN",
      contractType: symbolInfo?.contractType ?? null,
      quoteAsset: symbolInfo?.quoteAsset ?? null,
      marginAsset: symbolInfo?.marginAsset ?? null,
      pricePrecision: numberOrNull(symbolInfo?.pricePrecision),
      quantityPrecision: numberOrNull(symbolInfo?.quantityPrecision),
      tickSize: Number(priceFilter?.tickSize ?? 0.1),
      minPrice: numberOrNull(priceFilter?.minPrice),
      maxPrice: numberOrNull(priceFilter?.maxPrice),
      stepSize: Number(lotSize?.stepSize ?? 0.001),
      minQty: Number(lotSize?.minQty ?? 0),
      maxQty: numberOrNull(lotSize?.maxQty),
      minNotional: numberOrNull(minNotional?.notional),
      maxLeverage: null,
      maintenanceMarginBrackets: [],
      supportedOrderTypes: symbolInfo?.orderTypes ?? []
    };
    this.symbolRules.set(symbol, rules);
    return rules;
  }

  private async validateMarketOrderNotional(symbol: string, quantity: number, rules: FuturesSymbolRules): Promise<void> {
    if (rules.minNotional === null) return;
    const price = await this.getCurrentPrice(symbol);
    const notional = quantity * price;
    if (notional < rules.minNotional) {
      throw new Error("MIN_NOTIONAL");
    }
  }

  private async getCurrentPrice(symbol: string): Promise<number> {
    const cached = this.marketPrices.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return cached.price;

    const url = new URL("/fapi/v1/ticker/price", this.baseUrl);
    url.searchParams.set("symbol", symbol);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Binance ticker price failed ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { price?: string };
    const price = Number(body.price ?? 0);
    if (!Number.isFinite(price) || price <= 0) throw new Error("MARKET_PRICE_UNAVAILABLE");
    this.marketPrices.set(symbol, { expiresAt: Date.now() + 5_000, price });
    return price;
  }

  private async findAlgoOrderByClientAlgoId(clientAlgoId: string): Promise<BinanceAlgoOrderResponse | null> {
    try {
      return await this.signedGet<BinanceAlgoOrderResponse>("/fapi/v1/algoOrder", { clientAlgoId });
    } catch (error) {
      if (isOrderNotFound(error)) return null;
      throw error;
    }
  }
}

interface BinanceOrderResponse {
  orderId?: number | string;
  clientOrderId?: string;
  symbol?: string;
  side?: string;
  type?: string;
  status?: string;
  reduceOnly?: boolean | string;
  origQty?: string;
  executedQty?: string;
  avgPrice?: string;
}

interface BinanceAlgoOrderResponse {
  algoId?: number | string;
  clientAlgoId?: string;
  algoType?: string;
  symbol?: string;
  side?: string;
  type?: string;
  orderType?: string;
  algoStatus?: string;
  reduceOnly?: boolean | string;
  closePosition?: boolean | string;
  quantity?: string;
  triggerPrice?: string;
  actualPrice?: string;
}

interface BinanceExchangeInfo {
  symbols?: Array<{
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
      stepSize?: string;
      minQty?: string;
      maxQty?: string;
      tickSize?: string;
      notional?: string;
    }>;
  }>;
}

function oppositeSide(side: BinanceOrderSide): BinanceOrderSide {
  return side === "BUY" ? "SELL" : "BUY";
}

function toExecutionOrderLookupResult(order: BinanceOrderResponse | BinanceAlgoOrderResponse, fallbackSymbol: string, fallbackClientOrderId: string): ExecutionOrderLookupResult {
  const isAlgo = "algoId" in order || "clientAlgoId" in order || "orderType" in order;
  return {
    orderId: String(isAlgo ? (order as BinanceAlgoOrderResponse).algoId ?? fallbackClientOrderId : (order as BinanceOrderResponse).orderId ?? fallbackClientOrderId),
    clientOrderId: String(isAlgo ? (order as BinanceAlgoOrderResponse).clientAlgoId ?? fallbackClientOrderId : (order as BinanceOrderResponse).clientOrderId ?? fallbackClientOrderId),
    symbol: String(order.symbol ?? fallbackSymbol),
    side: String(order.side ?? "-"),
    type: String(isAlgo ? (order as BinanceAlgoOrderResponse).orderType ?? (order as BinanceAlgoOrderResponse).type ?? "-" : (order as BinanceOrderResponse).type ?? "-"),
    status: String(isAlgo ? (order as BinanceAlgoOrderResponse).algoStatus ?? "NEW" : (order as BinanceOrderResponse).status ?? "NEW"),
    reduceOnly: order.reduceOnly === true || order.reduceOnly === "true" || (order as BinanceAlgoOrderResponse).closePosition === true || (order as BinanceAlgoOrderResponse).closePosition === "true",
    originalQuantity: Number(isAlgo ? (order as BinanceAlgoOrderResponse).quantity ?? 0 : (order as BinanceOrderResponse).origQty ?? 0),
    executedQuantity: isAlgo ? 0 : Number((order as BinanceOrderResponse).executedQty ?? 0),
    averagePrice: isAlgo ? numberOrNull((order as BinanceAlgoOrderResponse).actualPrice) : numberOrNull((order as BinanceOrderResponse).avgPrice)
  };
}

function numberOrNull(value: string | number | undefined): number | null {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isOrderNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("-2013") || message.includes("Order does not exist") || message.includes("Unknown order sent") || message.includes(" 404:");
}
