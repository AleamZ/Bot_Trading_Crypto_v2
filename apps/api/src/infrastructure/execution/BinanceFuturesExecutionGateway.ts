import crypto from "node:crypto";
import type {
  ExecutionOrderContext,
  ExecutionOrderLookupResult,
  EmergencyCloseRequest,
  ProtectionOrderRequest,
  RecoverableExecutionGateway,
  SubmittedOrder
} from "../../application/ports/ExecutionGateway.js";
import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";
import { formatRuleNumber, normalizePrice, normalizeQuantity, validateAgainstSymbolRules, type FuturesSymbolRules } from "../../domain/symbol/SymbolRules.js";
import { PostEntryProtectionError } from "../../application/execution/PostEntryProtectionError.js";
import { isImmediateTriggerError } from "../../application/execution/ExecutionErrors.js";

type BinanceOrderSide = "BUY" | "SELL";
type EntryMode = "limit" | "market";
type EntryModePolicy = EntryMode | (() => EntryMode);
type MarginMode = "CROSS" | "ISOLATED";
type MarginModePolicy = MarginMode | (() => MarginMode);

const STOP_LOSS_SUBMIT_ATTEMPTS = 2;

interface SymbolAccountState {
  marginType: MarginMode | "UNKNOWN";
  leverage: number | null;
}

interface PositionRiskResponse {
  symbol?: string;
  positionAmt?: string;
  marginType?: string;
  leverage?: string;
}

interface OpenOrderResponse {
  symbol?: string;
  orderId?: number | string;
  algoId?: number | string;
}

export class BinanceFuturesExecutionGateway implements RecoverableExecutionGateway {
  private readonly baseUrl: string;
  private readonly symbolRules = new Map<string, FuturesSymbolRules>();
  private readonly marketPrices = new Map<string, { expiresAt: number; price: number }>();

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly mode: "testnet" | "live",
    private readonly entryModePolicy: EntryModePolicy,
    private readonly leverage: number,
    private readonly expectedMarginMode: MarginModePolicy = "ISOLATED",
    private readonly readOnlySoak = false
  ) {
    this.baseUrl = mode === "testnet" ? "https://demo-fapi.binance.com" : "https://fapi.binance.com";
  }

  // Resolved on every call so a settings change applies without rebuilding the runtime.
  private get entryMode(): EntryMode {
    return typeof this.entryModePolicy === "function" ? this.entryModePolicy() : this.entryModePolicy;
  }

  async submitBracketOrder(plan: EntryPlan, risk: RiskDecision, context?: ExecutionOrderContext): Promise<SubmittedOrder> {
    if (this.mode !== "testnet") throw new Error("REAL_EXECUTION_LOCKED");
    this.assertMutationAllowed();
    const entryMode = this.entryMode;
    const symbol = risk.symbol;
    const rules = await this.getSymbolRules(symbol);
    const entryOrderType = entryMode.toUpperCase();
    const validation = validateAgainstSymbolRules(rules, {
      symbol,
      orderType: entryOrderType,
      quantity: risk.quantity,
      price: entryMode === "limit" ? plan.entry : null,
      notional: risk.notional,
      leverage: risk.selectedLeverage
    });
    if (!validation.ok) throw new Error(validation.reason ?? "SYMBOL_RULE_VALIDATION_FAILED");
    const quantity = formatRuleNumber(validation.normalized.quantity);
    if (entryMode === "market") {
      await this.validateMarketOrderNotional(symbol, validation.normalized.quantity, rules);
    }

    await this.prepareSymbolForExecution(symbol, risk.selectedLeverage);

    const entrySide = plan.direction === "bullish" ? "BUY" : "SELL";
    const exitSide = oppositeSide(entrySide);
    await this.verifyPreparedSymbol(symbol, risk.selectedLeverage);
    // Last line of defence: a STOP_MARKET whose trigger is already crossed is rejected by
    // Binance (-2021), which would leave the new position without a stop loss.
    await this.assertPriceInsideProtection(symbol, plan);
    const entry = await this.submitEntryOrder(entryMode, symbol, entrySide, quantity, formatRuleNumber(normalizePrice(plan.entry, rules.tickSize)), context?.clientEntryOrderId);
    const contextIds = {
      ...(context?.clientEntryOrderId ? { clientEntryOrderId: context.clientEntryOrderId } : {}),
      ...(context?.clientStopOrderId ? { clientStopOrderId: context.clientStopOrderId } : {}),
      ...(context?.clientTakeProfitOrderId ? { clientTakeProfitOrderId: context.clientTakeProfitOrderId } : {})
    };
    const filledQuantity = Number(entry.executedQty ?? 0);
    const entryFilled = isFilledStatus(entry.status) || filledQuantity > 0;

    // A resting LIMIT entry gets its protection from reconciliation once a position exists.
    // Placing reduce-only exits before the fill leaves them orphaned if the entry never fills.
    if (entryMode === "limit" && !entryFilled) {
      return { orderId: String(entry.orderId), entryFilled: false, ...contextIds, mode: this.mode };
    }
    const partialOrder = (): SubmittedOrder => ({ orderId: String(entry.orderId), entryFilled: true, ...contextIds, mode: this.mode });

    let stopLoss: BinanceAlgoOrderResponse | null = null;
    let stopLossError: unknown = null;
    for (let attempt = 1; attempt <= STOP_LOSS_SUBMIT_ATTEMPTS && !stopLoss; attempt += 1) {
      try {
        stopLoss = await this.submitAlgoTriggerOrder(symbol, "STOP_MARKET", exitSide, formatRuleNumber(normalizePrice(plan.stopLoss, rules.tickSize)), context?.clientStopOrderId);
      } catch (error) {
        stopLossError = error;
        if (isImmediateTriggerError(error)) break;
      }
    }
    if (!stopLoss) {
      // Never keep a position open without a stop loss: flatten it immediately.
      const message = stopLossError instanceof Error ? stopLossError.message : String(stopLossError);
      try {
        await this.closePosition({
          symbol,
          side: exitSide,
          quantity: filledQuantity > 0 ? filledQuantity : validation.normalized.quantity,
          clientOrderId: `${context?.clientEntryOrderId ?? `smc_${Date.now()}`}`.replace(/_E$/, "_C")
        });
      } catch (closeError) {
        const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
        throw new PostEntryProtectionError(`STOP_LOSS_FAILED_AND_CLOSE_FAILED: ${message}; close: ${closeMessage}`, partialOrder());
      }
      // An ambiguous failure may still have created the closePosition stop; left behind it would
      // close the next position on this symbol, so remove it best-effort.
      if (context?.clientStopOrderId) await this.cancelOrderByClientOrderId(symbol, context.clientStopOrderId).catch(() => undefined);
      throw new Error(`PROTECTION_FAILED_POSITION_CLOSED: ${message}`);
    }

    let takeProfit: BinanceAlgoOrderResponse;
    try {
      takeProfit = await this.submitAlgoTriggerOrder(symbol, "TAKE_PROFIT_MARKET", exitSide, formatRuleNumber(normalizePrice(plan.takeProfit, rules.tickSize)), context?.clientTakeProfitOrderId);
    } catch (error) {
      // The stop loss is live, so the position is protected; reconciliation repairs the TP.
      throw new PostEntryProtectionError(error instanceof Error ? error.message : String(error), {
        ...partialOrder(),
        stopLossOrderId: String(stopLoss.algoId)
      });
    }

    return {
      orderId: String(entry.orderId),
      stopLossOrderId: String(stopLoss.algoId),
      takeProfitOrderId: String(takeProfit.algoId),
      entryFilled: true,
      ...contextIds,
      mode: this.mode
    };
  }

  private async assertPriceInsideProtection(symbol: string, plan: EntryPlan): Promise<void> {
    this.marketPrices.delete(symbol);
    const price = await this.getCurrentPrice(symbol);
    const inside = plan.direction === "bullish" ? price > plan.stopLoss && price < plan.takeProfit : price < plan.stopLoss && price > plan.takeProfit;
    if (!inside) throw new Error(`ENTRY_PRICE_BEYOND_PROTECTION: price ${price} outside SL ${plan.stopLoss} / TP ${plan.takeProfit}`);
  }

  async prepareSymbolForExecution(symbol: string, selectedLeverage: number): Promise<void> {
    if (this.mode !== "testnet") throw new Error("REAL_EXECUTION_LOCKED");
    this.assertMutationAllowed();
    if (!Number.isInteger(selectedLeverage) || selectedLeverage < 1) throw new Error("SYMBOL_PREPARATION_INVALID_LEVERAGE");

    let state = await this.readSymbolAccountState(symbol);
    const expectedMarginMode = this.getExpectedMarginMode();
    if (state.marginType !== expectedMarginMode) {
      const active = await this.readActiveSymbolState(symbol);
      if (active.position) throw new Error("SYMBOL_PREPARATION_POSITION_CONFLICT");
      if (active.regularOrders.length > 0) throw new Error("SYMBOL_PREPARATION_OPEN_ORDERS_CONFLICT");
      if (active.algoOrders.length > 0) throw new Error("SYMBOL_PREPARATION_ALGO_ORDERS_CONFLICT");

      await this.setMarginType(symbol, expectedMarginMode);
      state = await this.readSymbolAccountState(symbol);
      if (state.marginType !== expectedMarginMode) throw new Error("SYMBOL_PREPARATION_MARGIN_MODE_MISMATCH");
    }

    if (state.leverage !== selectedLeverage) {
      await this.setLeverage(symbol, selectedLeverage);
      state = await this.readSymbolAccountState(symbol);
      if (state.leverage !== selectedLeverage) throw new Error("SYMBOL_PREPARATION_LEVERAGE_MISMATCH");
    }

    await this.verifyPreparedSymbol(symbol, selectedLeverage);
  }

  private async verifyPreparedSymbol(symbol: string, selectedLeverage: number): Promise<void> {
    const state = await this.readSymbolAccountState(symbol);
    if (state.marginType !== this.getExpectedMarginMode()) throw new Error("SYMBOL_PREPARATION_MARGIN_MODE_MISMATCH");
    if (state.leverage !== selectedLeverage) throw new Error("SYMBOL_PREPARATION_LEVERAGE_MISMATCH");
  }

  private getExpectedMarginMode(): MarginMode {
    return typeof this.expectedMarginMode === "function" ? this.expectedMarginMode() : this.expectedMarginMode;
  }

  private async readSymbolAccountState(symbol: string): Promise<SymbolAccountState> {
    const positions = await this.signedGet<PositionRiskResponse[]>("/fapi/v2/positionRisk", { symbol });
    const position = positions.find((item) => item.symbol === symbol) ?? positions[0];
    const marginType = String(position?.marginType ?? "").toUpperCase();
    return {
      marginType: marginType === "CROSS" || marginType === "ISOLATED" ? marginType : "UNKNOWN",
      leverage: numberOrNull(position?.leverage)
    };
  }

  private async readActiveSymbolState(symbol: string): Promise<{ position: boolean; regularOrders: OpenOrderResponse[]; algoOrders: OpenOrderResponse[] }> {
    const [positions, regularOrders, algoOrders] = await Promise.all([
      this.signedGet<PositionRiskResponse[]>("/fapi/v2/positionRisk", { symbol }),
      this.signedGet<OpenOrderResponse[]>("/fapi/v1/openOrders", { symbol }),
      this.signedGet<OpenOrderResponse[]>("/fapi/v1/openAlgoOrders", { symbol })
    ]);
    return {
      position: positions.some((item) => Math.abs(Number(item.positionAmt ?? 0)) > 0),
      regularOrders,
      algoOrders
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
    this.assertMutationAllowed();
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
    const existing = await this.findProtectionOrder(request.symbol, request.type, request.side, request.clientOrderId);
    if (existing) return existing;

    const order = await this.submitAlgoTriggerOrder(
      request.symbol,
      request.type,
      request.side,
      formatRuleNumber(validation.normalized.stopPrice ?? normalizePrice(request.stopPrice, rules.tickSize)),
      request.clientOrderId
    );
    return toExecutionOrderLookupResult(order, request.symbol, request.clientOrderId);
  }

  async findProtectionOrder(symbol: string, type: ProtectionOrderRequest["type"], side: ProtectionOrderRequest["side"], clientOrderId: string): Promise<ExecutionOrderLookupResult | null> {
    const order = await this.findAlgoOrderByClientAlgoId(clientOrderId);
    if (!order) return null;
    const status = String(order.algoStatus ?? "NEW").toUpperCase();
    if (["CANCELED", "CANCELLED", "EXPIRED", "TRIGGERED", "REJECTED"].includes(status) || String(order.symbol ?? symbol) !== symbol || String(order.orderType ?? order.type ?? "") !== type) return null;
    if (String(order.side ?? "") !== side || !(order.reduceOnly === true || order.reduceOnly === "true" || order.closePosition === true || order.closePosition === "true")) return null;
    return toExecutionOrderLookupResult(order, symbol, clientOrderId);
  }

  async closePosition(request: EmergencyCloseRequest): Promise<ExecutionOrderLookupResult> {
    this.assertMutationAllowed();
    const existing = await this.findOrderByClientOrderId(request.symbol, request.clientOrderId);
    if (existing) return existing;
    const rules = await this.getSymbolRules(request.symbol);
    const validation = validateAgainstSymbolRules(rules, {
      symbol: request.symbol,
      orderType: "MARKET",
      quantity: request.quantity,
      notional: request.quantity * (await this.getCurrentPrice(request.symbol)),
      leverage: 1
    });
    if (!validation.ok) throw new Error(validation.reason ?? "EMERGENCY_CLOSE_VALIDATION_FAILED");
    const params = new URLSearchParams({
      symbol: request.symbol,
      side: request.side,
      type: "MARKET",
      quantity: formatRuleNumber(validation.normalized.quantity),
      reduceOnly: "true",
      newClientOrderId: request.clientOrderId,
      timestamp: String(Date.now())
    });
    const order = await this.signedPost<BinanceOrderResponse>("/fapi/v1/order", params, "Binance emergency close failed");
    return toExecutionOrderLookupResult(order, request.symbol, request.clientOrderId);
  }

  async cancelOrderByClientOrderId(symbol: string, clientOrderId: string): Promise<void> {
    this.assertMutationAllowed();
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

  private async submitEntryOrder(entryMode: EntryMode, symbol: string, side: BinanceOrderSide, quantity: string, price: string, clientOrderId?: string): Promise<BinanceOrderResponse> {
    const params = new URLSearchParams({
      symbol,
      side,
      type: entryMode.toUpperCase(),
      quantity,
      newOrderRespType: "RESULT",
      timestamp: String(Date.now())
    });
    if (clientOrderId) params.set("newClientOrderId", clientOrderId);

    if (entryMode === "limit") {
      params.set("timeInForce", "GTC");
      params.set("price", price);
    }

    return this.signedPost("/fapi/v1/order", params, "Binance entry order failed");
  }

  // closePosition=true exits whatever size is actually open (partial fills, later fills),
  // instead of a fixed quantity that can drift from the real position.
  private async submitAlgoTriggerOrder(
    symbol: string,
    type: "STOP_MARKET" | "TAKE_PROFIT_MARKET",
    side: BinanceOrderSide,
    triggerPrice: string,
    clientOrderId?: string
  ): Promise<BinanceAlgoOrderResponse> {
    const params = new URLSearchParams({
      algoType: "CONDITIONAL",
      symbol,
      side,
      type,
      triggerPrice,
      closePosition: "true",
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

  private async setMarginType(symbol: string, marginMode: MarginMode): Promise<void> {
    const params = new URLSearchParams({
      symbol,
      marginType: marginMode,
      timestamp: String(Date.now())
    });
    await this.signedPost("/fapi/v1/marginType", params, "Binance margin mode update failed");
  }

  private async signedPost<T = unknown>(path: string, params: URLSearchParams, label: string): Promise<T> {
    this.assertMutationAllowed();
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
    this.assertMutationAllowed();
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

  private assertMutationAllowed(): void {
    if (this.mode !== "testnet") throw new Error("REAL_EXECUTION_LOCKED");
    if (this.readOnlySoak) throw new Error("READ_ONLY_SOAK_EXECUTION_BLOCKED");
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

function isFilledStatus(status: string | undefined): boolean {
  return status === "FILLED" || status === "PARTIALLY_FILLED";
}

function isOrderNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("-2013") || message.includes("Order does not exist") || message.includes("Unknown order sent") || message.includes(" 404:");
}
