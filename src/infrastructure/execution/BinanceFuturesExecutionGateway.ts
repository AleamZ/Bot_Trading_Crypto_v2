import crypto from "node:crypto";
import type { ExecutionGateway, SubmittedOrder } from "../../application/ports/ExecutionGateway.js";
import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";

type BinanceOrderSide = "BUY" | "SELL";
type EntryMode = "limit" | "market";

export class BinanceFuturesExecutionGateway implements ExecutionGateway {
  private readonly baseUrl: string;
  private symbolRules: SymbolRules | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly mode: "testnet" | "live",
    private readonly symbol: string,
    private readonly entryMode: EntryMode,
    private readonly leverage: number
  ) {
    this.baseUrl = mode === "testnet" ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
  }

  async submitBracketOrder(plan: EntryPlan, risk: RiskDecision): Promise<SubmittedOrder> {
    const rules = await this.getSymbolRules();
    const quantity = formatByStep(risk.quantity, rules.stepSize);
    if (Number(quantity) <= 0) throw new Error("Rounded quantity is zero");

    await this.setLeverage();

    const entrySide = plan.direction === "bullish" ? "BUY" : "SELL";
    const exitSide = oppositeSide(entrySide);
    const entry = await this.submitEntryOrder(entrySide, quantity, formatByStep(plan.entry, rules.tickSize));
    const stopLoss = await this.submitTriggerOrder("STOP_MARKET", exitSide, quantity, formatByStep(plan.stopLoss, rules.tickSize));
    const takeProfit = await this.submitTriggerOrder("TAKE_PROFIT_MARKET", exitSide, quantity, formatByStep(plan.takeProfit, rules.tickSize));

    return {
      orderId: String(entry.orderId),
      stopLossOrderId: String(stopLoss.orderId),
      takeProfitOrderId: String(takeProfit.orderId),
      mode: this.mode
    };
  }

  private async submitEntryOrder(side: BinanceOrderSide, quantity: string, price: string): Promise<BinanceOrderResponse> {
    const params = new URLSearchParams({
      symbol: this.symbol,
      side,
      type: this.entryMode.toUpperCase(),
      quantity,
      timestamp: String(Date.now())
    });

    if (this.entryMode === "limit") {
      params.set("timeInForce", "GTC");
      params.set("price", price);
    }

    return this.signedPost("/fapi/v1/order", params, "Binance entry order failed");
  }

  private async submitTriggerOrder(
    type: "STOP_MARKET" | "TAKE_PROFIT_MARKET",
    side: BinanceOrderSide,
    quantity: string,
    stopPrice: string
  ): Promise<BinanceOrderResponse> {
    const params = new URLSearchParams({
      symbol: this.symbol,
      side,
      type,
      quantity,
      stopPrice,
      reduceOnly: "true",
      workingType: "CONTRACT_PRICE",
      timestamp: String(Date.now())
    });

    return this.signedPost("/fapi/v1/order", params, `Binance ${type} order failed`);
  }

  private async setLeverage(): Promise<void> {
    const params = new URLSearchParams({
      symbol: this.symbol,
      leverage: String(Math.trunc(this.leverage)),
      timestamp: String(Date.now())
    });
    await this.signedPost("/fapi/v1/leverage", params, "Binance leverage update failed");
  }

  private async signedPost(path: string, params: URLSearchParams, label: string): Promise<BinanceOrderResponse> {
    params.set("signature", this.sign(params.toString()));
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": this.apiKey },
      body: params
    });

    if (!response.ok) {
      throw new Error(`${label} ${response.status}: ${await response.text()}`);
    }

    return (await response.json()) as BinanceOrderResponse;
  }

  private sign(payload: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(payload).digest("hex");
  }

  private async getSymbolRules(): Promise<SymbolRules> {
    if (this.symbolRules) return this.symbolRules;

    const url = new URL("/fapi/v1/exchangeInfo", this.baseUrl);
    url.searchParams.set("symbol", this.symbol);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Binance exchangeInfo failed ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as BinanceExchangeInfo;
    const symbolInfo = body.symbols?.find((item) => item.symbol === this.symbol);
    const lotSize = symbolInfo?.filters.find((filter) => filter.filterType === "LOT_SIZE");
    const priceFilter = symbolInfo?.filters.find((filter) => filter.filterType === "PRICE_FILTER");
    const minNotional = symbolInfo?.filters.find((filter) => filter.filterType === "MIN_NOTIONAL");
    const stepSize = Number(lotSize?.stepSize ?? 0.001);
    const tickSize = Number(priceFilter?.tickSize ?? 0.1);
    this.symbolRules = { stepSize, tickSize, minNotional: Number(minNotional?.notional ?? 5) };
    return this.symbolRules;
  }
}

interface SymbolRules {
  stepSize: number;
  tickSize: number;
  minNotional: number;
}

interface BinanceOrderResponse {
  orderId?: number | string;
}

interface BinanceExchangeInfo {
  symbols?: Array<{
    symbol: string;
    filters: Array<{
      filterType: string;
      stepSize?: string;
      tickSize?: string;
      notional?: string;
    }>;
  }>;
}

function oppositeSide(side: BinanceOrderSide): BinanceOrderSide {
  return side === "BUY" ? "SELL" : "BUY";
}

function formatByStep(value: number, step: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (!Number.isFinite(step) || step <= 0) return Number(value.toFixed(8)).toString();

  const precision = decimalPlaces(step);
  const rounded = Math.floor(value / step) * step;
  return rounded.toFixed(precision).replace(/\.?0+$/, "");
}

function decimalPlaces(value: number): number {
  const text = value.toString();
  if (text.includes("e-")) return Number(text.split("e-")[1] ?? 8);
  return text.includes(".") ? text.split(".")[1]?.length ?? 0 : 0;
}
