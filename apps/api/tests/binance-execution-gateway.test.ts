import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceFuturesExecutionGateway } from "../src/infrastructure/execution/BinanceFuturesExecutionGateway.js";
import { BinanceFuturesAccountClient } from "../src/infrastructure/execution/BinanceFuturesAccountClient.js";
import type { EntryPlan } from "../src/domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../src/domain/risk/RiskDecision.js";

describe("BinanceFuturesExecutionGateway", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks every Binance mutation in read-only soak mode after allowing account reads", async () => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal("fetch", preparationFetch({ marginType: "ISOLATED", leverage: 1, positionAmt: "0" }, requests));
    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "market", 1, "ISOLATED", true);

    await expect(gateway.submitBracketOrder(plan("bullish"), risk("XRPUSDT", 100))).rejects.toThrow("READ_ONLY_SOAK_EXECUTION_BLOCKED");
    expect(requests.some((request) => request.method === "POST" || request.method === "DELETE")).toBe(false);
  });

  it("blocks DELETE mutations before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "market", 1, "ISOLATED", true);

    await expect(gateway.cancelOrderByClientOrderId("XRPUSDT", "client-order")).rejects.toThrow("READ_ONLY_SOAK_EXECUTION_BLOCKED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows signed GET reads in read-only soak mode", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ orderId: 1, symbol: "XRPUSDT", clientOrderId: "client-order", status: "NEW" }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "market", 1, "ISOLATED", true);

    await expect(gateway.findOrderByClientOrderId("XRPUSDT", "client-order")).resolves.toMatchObject({ orderId: "1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps MARKET entries on the regular order endpoint and sends the approved quantity unchanged", async () => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      requests.push(capture(input, init));
      const url = String(input);
      if (url.includes("/fapi/v1/exchangeInfo")) return jsonResponse(exchangeInfo("XRPUSDT"));
      if (url.includes("/fapi/v1/ticker/price")) return jsonResponse({ symbol: "XRPUSDT", price: "1.5088" });
      if (url.includes("/fapi/v2/positionRisk")) return jsonResponse([{ symbol: "XRPUSDT", positionAmt: "0", marginType: "ISOLATED", leverage: "1" }]);
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
    const leverage = requests.find((request) => request.path === "/fapi/v1/leverage" && request.method === "POST");
    expect(leverage).toBeUndefined();
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
      if (url.includes("/fapi/v2/positionRisk")) return jsonResponse([{ symbol: "XRPUSDT", positionAmt: "0", marginType: "ISOLATED", leverage: "1" }]);
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

  it("prepares an isolated symbol and synchronizes selected leverage", async () => {
    const requests: CapturedRequest[] = [];
    const state = { marginType: "CROSS", leverage: 5, positionAmt: "0" };
    vi.stubGlobal("fetch", preparationFetch(state, requests));
    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "market", 125, "ISOLATED");

    await gateway.prepareSymbolForExecution("XRPUSDT", 2);

    expect(requests.filter((request) => request.path === "/fapi/v1/marginType" && request.method === "POST")).toHaveLength(1);
    expect(requests.filter((request) => request.path === "/fapi/v1/leverage" && request.method === "POST")).toHaveLength(1);
    expect(state).toMatchObject({ marginType: "ISOLATED", leverage: 2 });
  });

  it.each([
    ["position", { marginType: "CROSS", leverage: 5, positionAmt: "1" }, "SYMBOL_PREPARATION_POSITION_CONFLICT"],
    ["regular order", { marginType: "CROSS", leverage: 5, positionAmt: "0" }, "SYMBOL_PREPARATION_OPEN_ORDERS_CONFLICT"],
    ["algo order", { marginType: "CROSS", leverage: 5, positionAmt: "0" }, "SYMBOL_PREPARATION_ALGO_ORDERS_CONFLICT"]
  ])("blocks margin preparation when %s exists", async (kind, state, expected) => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal("fetch", preparationFetch(state, requests, {
      regularOrders: kind === "regular order" ? [{ symbol: "XRPUSDT", orderId: 1 }] : [],
      algoOrders: kind === "algo order" ? [{ symbol: "XRPUSDT", algoId: 2 }] : []
    }));
    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "market", 125, "ISOLATED");

    await expect(gateway.prepareSymbolForExecution("XRPUSDT", 2)).rejects.toThrow(expected);
    expect(requests.some((request) => request.path === "/fapi/v1/marginType" && request.method === "POST")).toBe(false);
  });

  it("fails closed when mutation succeeds but authoritative re-read disagrees", async () => {
    const requests: CapturedRequest[] = [];
    const state = { marginType: "CROSS", leverage: 5, positionAmt: "0" };
    vi.stubGlobal("fetch", preparationFetch(state, requests, { ignoreMarginMutation: true }));
    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "market", 125, "ISOLATED");

    await expect(gateway.prepareSymbolForExecution("XRPUSDT", 2)).rejects.toThrow("SYMBOL_PREPARATION_MARGIN_MODE_MISMATCH");
  });

  it("fails closed when Binance refuses a leverage mutation", async () => {
    const requests: CapturedRequest[] = [];
    const state = { marginType: "ISOLATED", leverage: 5, positionAmt: "0" };
    vi.stubGlobal("fetch", preparationFetch(state, requests, { leverageMutationError: true }));
    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "market", 125, "ISOLATED");

    await expect(gateway.prepareSymbolForExecution("XRPUSDT", 2)).rejects.toThrow("Binance leverage update failed");
  });

  it("performs a final state verification immediately before entry", async () => {
    const requests: CapturedRequest[] = [];
    const state = { marginType: "ISOLATED", leverage: 2, positionAmt: "0" };
    vi.stubGlobal("fetch", preparationFetch(state, requests, { mutateBeforeFinalVerification: "leverage" }));
    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "testnet", "market", 125, "ISOLATED");

    await expect(gateway.submitBracketOrder(plan("bullish"), { ...risk("XRPUSDT", 100), leverage: 2, selectedLeverage: 2 }, {
      executionIntentId: "intent",
      setupKey: "setup",
      clientEntryOrderId: "smc_intent_E",
      clientStopOrderId: "smc_intent_SL",
      clientTakeProfitOrderId: "smc_intent_TP"
    })).rejects.toThrow("SYMBOL_PREPARATION_LEVERAGE_MISMATCH");
    expect(requests.some((request) => request.path === "/fapi/v1/order" && request.method === "POST")).toBe(false);
  });

  it("does not mutate Mainnet and keeps REAL execution locked", async () => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal("fetch", preparationFetch({ marginType: "CROSS", leverage: 5, positionAmt: "0" }, requests));
    const gateway = new BinanceFuturesExecutionGateway("key", "secret", "live", "market", 125, "ISOLATED");

    await expect(gateway.submitBracketOrder(plan("bullish"), { ...risk("XRPUSDT", 100), leverage: 2, selectedLeverage: 2 })).rejects.toThrow("REAL_EXECUTION_LOCKED");
    expect(requests).toHaveLength(0);
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
    leverageNeededForMargin: 1,
    effectiveMaxLeverage: 75,
    selectedLeverage: 1,
    requiredMargin: 150.88,
    maxLeverage: 75,
    maxMarginUsagePercent: 20,
    marginMode: "ISOLATED",
    liquidationSafetyBufferPercent: 0.5,
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
    maintenanceMarginRate: 0.004,
    maintenanceMarginAmount: 0.60352,
    maintenanceMarginBracket: { bracket: 1, notionalFloor: 0, notionalCap: null, cumulativeMaintenanceAmount: 0, initialLeverage: 75 },
    estimatedLiquidationPrice: 0.001,
    distanceSlToLiquidation: 1.3078,
    liquidationSafetyStatus: "SAFE",
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

function preparationFetch(
  state: { marginType: string; leverage: number; positionAmt: string },
  requests: CapturedRequest[],
  options: {
    regularOrders?: unknown[];
    algoOrders?: unknown[];
    ignoreMarginMutation?: boolean;
    leverageMutationError?: boolean;
    mutateBeforeFinalVerification?: "margin" | "leverage";
  } = {}
) {
  let positionRiskReads = 0;
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const request = capture(input, init);
    requests.push(request);
    const url = String(input);
    if (url.includes("/fapi/v1/exchangeInfo")) return jsonResponse(exchangeInfo("XRPUSDT"));
    if (url.includes("/fapi/v1/ticker/price")) return jsonResponse({ symbol: "XRPUSDT", price: "1.5088" });
    if (url.includes("/fapi/v2/positionRisk")) {
      positionRiskReads += 1;
      if (options.mutateBeforeFinalVerification === "margin" && positionRiskReads >= 3) state.marginType = "CROSS";
      if (options.mutateBeforeFinalVerification === "leverage" && positionRiskReads >= 3) state.leverage = 5;
      return jsonResponse([{ symbol: "XRPUSDT", positionAmt: state.positionAmt, marginType: state.marginType, leverage: String(state.leverage) }]);
    }
    if (url.includes("/fapi/v1/openOrders")) return jsonResponse(options.regularOrders ?? []);
    if (url.includes("/fapi/v1/openAlgoOrders")) return jsonResponse(options.algoOrders ?? []);
    if (url.includes("/fapi/v1/marginType") && init?.method === "POST") {
      if (!options.ignoreMarginMutation) state.marginType = "ISOLATED";
      return jsonResponse({ code: 200, msg: "success" });
    }
    if (url.includes("/fapi/v1/leverage") && init?.method === "POST") {
      if (options.leverageMutationError) return jsonResponse({ code: -4000, msg: "rejected" }, 400);
      state.leverage = Number(request.params.leverage);
      return jsonResponse({ symbol: "XRPUSDT", leverage: state.leverage });
    }
    if (url.includes("/fapi/v1/order") && init?.method === "POST") return jsonResponse({ orderId: 11, status: "FILLED", type: "MARKET", symbol: "XRPUSDT" });
    if (url.includes("/fapi/v1/algoOrder") && init?.method === "POST") return jsonResponse({ algoId: 21, algoStatus: "NEW", orderType: request.params.type, symbol: "XRPUSDT" });
    return jsonResponse({}, 404);
  });
}
