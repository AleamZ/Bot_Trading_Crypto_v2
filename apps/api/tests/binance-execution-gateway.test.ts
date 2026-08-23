import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceFuturesExecutionGateway } from "../src/infrastructure/execution/BinanceFuturesExecutionGateway.js";
import { BinanceFuturesAccountClient } from "../src/infrastructure/execution/BinanceFuturesAccountClient.js";
import type { EntryPlan } from "../src/domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../src/domain/risk/RiskDecision.js";

describe("BinanceFuturesExecutionGateway", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps MARKET entries on the regular order endpoint and sends the approved quantity unchanged", async () => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      requests.push(capture(input, init));
      const url = String(input);
      if (url.includes("/fapi/v1/exchangeInfo")) return jsonResponse(exchangeInfo("XRPUSDT"));
      if (url.includes("/fapi/v1/ticker/price")) return jsonResponse({ symbol: "XRPUSDT", price: "1.5088" });
      if (url.includes("/fapi/v1/leverage")) return jsonResponse({ symbol: "XRPUSDT", leverage: 1 });
      if (url.includes("/fapi/v1/order")) return jsonResponse({ orderId: 11, clientOrderId: bodyParam(init, "newClientOrderId"), symbol: "XRPUSDT", side: "BUY", type: "MARKET", status: "FILLED", origQty: bodyParam(init, "quantity"), executedQty: bodyParam(init, "quantity"), avgPrice: "1.5088" });
      if (url.includes("/fapi/v1/algoOrder")) return jsonResponse({ algoId: bodyParam(init, "type") === "STOP_MARKET" ? 21 : 22, clientAlgoId: bodyParam(init, "clientAlgoId"), symbol: "XRPUSDT", side: "SELL", orderType: bodyParam(init, "type"), algoStatus: "NEW", quantity: bodyParam(init, "quantity"), triggerPrice: bodyParam(init, "triggerPrice"), reduceOnly: true });
      return jsonResponse({}, 404);
    }));

    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "market", 1);
    const submitted = await gateway.submitBracketOrder(plan("bullish"), risk("XRPUSDT", 100), {
      executionIntentId: "intent",
      setupKey: "setup",
      clientEntryOrderId: "smc_intent_E",
      clientStopOrderId: "smc_intent_SL",
      clientTakeProfitOrderId: "smc_intent_TP"
    });

    const entry = requests.find((request) => request.path === "/fapi/v1/order" && request.method === "POST");
    expect(entry?.params).toMatchObject({
      symbol: "XRPUSDT",
      side: "BUY",
      type: "MARKET",
      quantity: "100",
      newClientOrderId: "smc_intent_E"
    });
    expect(entry?.params.price).toBeUndefined();
    expect(entry?.params.timeInForce).toBeUndefined();
    expect(submitted.stopLossOrderId).toBe("21");
    expect(submitted.takeProfitOrderId).toBe("22");
  });

  it("submits STOP_MARKET and TAKE_PROFIT_MARKET protection through the Algo API", async () => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      requests.push(capture(input, init));
      const url = String(input);
      if (url.includes("/fapi/v1/exchangeInfo")) return jsonResponse(exchangeInfo("XRPUSDT"));
      if (url.includes("/fapi/v1/ticker/price")) return jsonResponse({ symbol: "XRPUSDT", price: "1.5088" });
      if (url.includes("/fapi/v1/leverage")) return jsonResponse({ symbol: "XRPUSDT", leverage: 1 });
      if (url.includes("/fapi/v1/order")) return jsonResponse({ orderId: 11, clientOrderId: "smc_intent_E", symbol: "XRPUSDT", side: "SELL", type: "MARKET", status: "FILLED", origQty: "100", executedQty: "100", avgPrice: "1.5088" });
      if (url.includes("/fapi/v1/algoOrder")) return jsonResponse({ algoId: bodyParam(init, "type") === "STOP_MARKET" ? 21 : 22, clientAlgoId: bodyParam(init, "clientAlgoId"), symbol: "XRPUSDT", side: "BUY", orderType: bodyParam(init, "type"), algoStatus: "NEW", quantity: bodyParam(init, "quantity"), triggerPrice: bodyParam(init, "triggerPrice"), reduceOnly: true });
      return jsonResponse({}, 404);
    }));

    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "market", 1);
    await gateway.submitBracketOrder(plan("bearish"), risk("XRPUSDT", 100), {
      executionIntentId: "intent",
      setupKey: "setup",
      clientEntryOrderId: "smc_intent_E",
      clientStopOrderId: "smc_intent_SL",
      clientTakeProfitOrderId: "smc_intent_TP"
    });

    const algoOrders = requests.filter((request) => request.path === "/fapi/v1/algoOrder" && request.method === "POST");
    expect(algoOrders).toHaveLength(2);
    expect(algoOrders[0]?.params).toMatchObject({
      symbol: "XRPUSDT",
      side: "BUY",
      algoType: "CONDITIONAL",
      type: "STOP_MARKET",
      quantity: "100",
      triggerPrice: "1.7088",
      reduceOnly: "true",
      workingType: "CONTRACT_PRICE",
      clientAlgoId: "smc_intent_SL"
    });
    expect(algoOrders[0]?.params.stopPrice).toBeUndefined();
    expect(algoOrders[0]?.params.newClientOrderId).toBeUndefined();
    expect(algoOrders[1]?.params).toMatchObject({
      algoType: "CONDITIONAL",
      type: "TAKE_PROFIT_MARKET",
      triggerPrice: "1.1088",
      clientAlgoId: "smc_intent_TP"
    });
  });

  it("checks an existing deterministic Algo order before repairing protection", async () => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      requests.push(capture(input, init));
      const url = String(input);
      if (url.includes("/fapi/v1/exchangeInfo")) return jsonResponse(exchangeInfo("XRPUSDT"));
      if (url.includes("/fapi/v1/algoOrder") && !init?.method) return jsonResponse({ algoId: 77, clientAlgoId: "smc_intent_SL", symbol: "XRPUSDT", side: "SELL", orderType: "STOP_MARKET", algoStatus: "NEW", quantity: "100", triggerPrice: "1.3088", reduceOnly: true });
      return jsonResponse({}, 404);
    }));

    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "market", 1);
    const recovered = await gateway.submitProtectionOrder({
      symbol: "XRPUSDT",
      side: "SELL",
      type: "STOP_MARKET",
      quantity: 100,
      stopPrice: 1.3088,
      clientOrderId: "smc_intent_SL"
    });

    expect(recovered.orderId).toBe("77");
    expect(requests.some((request) => request.path === "/fapi/v1/algoOrder" && request.method === "POST")).toBe(false);
  });

  it("maps open Algo orders into account open orders for reconciliation", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/fapi/v1/openOrders")) return jsonResponse([]);
      if (url.includes("/fapi/v1/openAlgoOrders")) return jsonResponse([
        {
          algoId: 21,
          clientAlgoId: "smc_intent_SL",
          symbol: "XRPUSDT",
          side: "SELL",
          orderType: "STOP_MARKET",
          algoStatus: "NEW",
          quantity: "100",
          triggerPrice: "1.3088",
          reduceOnly: true,
          createTime: 1787496850000,
          updateTime: 1787496850000
        }
      ]);
      return jsonResponse({}, 404);
    }));

    const client = new BinanceFuturesAccountClient("key", "secret", true);
    const orders = await client.getOpenOrders("XRPUSDT");

    expect(orders).toMatchObject([
      {
        orderId: "21",
        clientOrderId: "smc_intent_SL",
        symbol: "XRPUSDT",
        side: "SELL",
        type: "STOP_MARKET",
        stopPrice: 1.3088,
        quantity: 100,
        reduceOnly: true
      }
    ]);
  });
});

function plan(direction: "bullish" | "bearish"): EntryPlan {
  return direction === "bullish"
    ? { direction, entry: 1.5088, stopLoss: 1.3088, takeProfit: 1.9088, source: "fvg-ce" }
    : { direction, entry: 1.5088, stopLoss: 1.7088, takeProfit: 1.1088, source: "fvg-ce" };
}

function risk(symbol: string, quantity: number): RiskDecision {
  return {
    accepted: true,
    reason: "Risk passed",
    symbol,
    margin: 150.88,
    leverage: 1,
    requiredLeverage: 0.03,
    selectedLeverage: 1,
    requiredMargin: 150.88,
    maxLeverage: 75,
    maxMarginUsagePercent: 20,
    positionSize: 150.88,
    quantity,
    notional: 150.88,
    entry: 1.5088,
    stopLoss: 1.3088,
    takeProfit: 1.9088,
    estimatedLoss: 20,
    estimatedProfit: 40,
    actualRiskUsdt: 20,
    targetRiskUsdt: 20,
    riskPerTradeUsdt: 20,
    availableBalance: 5000,
    maxAllowedMargin: 1000,
    marginUsagePercent: 3.0176,
    riskReward: 2,
    createdAt: "2026-08-23T00:00:00.000Z"
  };
}

function exchangeInfo(symbol: string) {
  return {
    symbols: [
      {
        symbol,
        status: "TRADING",
        contractType: "PERPETUAL",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        pricePrecision: 4,
        quantityPrecision: 1,
        orderTypes: ["LIMIT", "MARKET", "STOP", "STOP_MARKET", "TAKE_PROFIT", "TAKE_PROFIT_MARKET"],
        filters: [
          { filterType: "PRICE_FILTER", minPrice: "0.0143", maxPrice: "100000", tickSize: "0.0001" },
          { filterType: "LOT_SIZE", minQty: "0.1", maxQty: "1000000", stepSize: "0.1" },
          { filterType: "MIN_NOTIONAL", notional: "5" }
        ]
      }
    ]
  };
}

interface CapturedRequest {
  path: string;
  method: string;
  params: Record<string, string>;
}

function capture(input: string | URL, init?: RequestInit): CapturedRequest {
  const url = new URL(String(input));
  return {
    path: url.pathname,
    method: init?.method ?? "GET",
    params: {
      ...Object.fromEntries(url.searchParams.entries()),
      ...Object.fromEntries(new URLSearchParams(init?.body as URLSearchParams | undefined).entries())
    }
  };
}

function bodyParam(init: RequestInit | undefined, key: string): string {
  return new URLSearchParams(init?.body as URLSearchParams | undefined).get(key) ?? "";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
