import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { AiChatOrderDesk, assessChatOrder, type ChatOrderMarket, type ChatOrderRequest } from "../src/application/ai/AiChatOrders.js";
import { AI_CHAT_MAX_TOOL_ROUNDS, AiChatService, mentionedSymbols, type AiChatContext, type AiChatToolbox, type AiChatToolEvent } from "../src/application/ai/AiChatService.js";
import { CryptoNewsService, parseRssItems } from "../src/application/ai/CryptoNewsService.js";
import { LlmRequestError, LocalLlmClient, type LlmToolRequest, type LlmToolResponse, type StreamingLlmClient, type ToolCallingLlmClient } from "../src/application/ai/LocalLlmClient.js";
import { defaultTradingSettings, type AppConfig } from "../src/application/config/AppConfig.js";
import type { EntryPlan } from "../src/domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../src/domain/risk/RiskDecision.js";
import type { FuturesSymbolRules } from "../src/domain/symbol/SymbolRules.js";
import { createAiChatToolbox, streamAiChatReply } from "../src/presentation/http/AiChatRoute.js";

const ACCOUNT = "account-1";
const USER = "user-1";

describe("LocalLlmClient tool calling", () => {
  it("sends tools and tool results in OpenAI format and reads tool_calls back", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ model: "m1", choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_crypto_news", arguments: '{"coin":"BTC"}' } }] } }] }),
        { status: 200 }
      );
    });
    const client = new LocalLlmClient({ baseUrl: "http://llm/v1", apiKey: "k", timeoutMs: 1_000 }, fetchImpl as unknown as typeof fetch);

    const result = await client.completeWithTools({
      model: "m",
      messages: [
        { role: "user", content: "tin btc?" },
        { role: "assistant", content: null, toolCalls: [{ id: "c0", name: "get_market_analysis", arguments: '{"symbol":"BTCUSDT"}' }] },
        { role: "tool", toolCallId: "c0", content: '{"ok":true}' }
      ],
      tools: [{ name: "get_crypto_news", description: "news", parameters: { type: "object" } }]
    });

    expect(result).toEqual({ model: "m1", content: "", toolCalls: [{ id: "c1", name: "get_crypto_news", arguments: '{"coin":"BTC"}' }] });
    expect(body.tools).toEqual([{ type: "function", function: { name: "get_crypto_news", description: "news", parameters: { type: "object" } } }]);
    expect(body.messages).toEqual([
      { role: "user", content: "tin btc?" },
      { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "get_market_analysis", arguments: '{"symbol":"BTCUSDT"}' } }] },
      { role: "tool", tool_call_id: "c0", content: '{"ok":true}' }
    ]);
  });

  it("omits tools when none are offered and rejects an empty answer", async () => {
    let body: Record<string, unknown> = {};
    const client = new LocalLlmClient({ baseUrl: "http://llm/v1", apiKey: null, timeoutMs: 1_000 }, (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 });
    }) as unknown as typeof fetch);

    await expect(client.completeWithTools({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] })).rejects.toMatchObject({ code: "LLM_EMPTY_RESPONSE" });
    expect(body.tools).toBeUndefined();
  });
});

describe("AI chat tool loop", () => {
  it("runs the tools the model asks for, then returns its text answer", async () => {
    const llm = new ScriptedLlm([
      { model: "m", content: "", toolCalls: [{ id: "a", name: "get_market_analysis", arguments: '{"symbol":"btc"}' }, { id: "b", name: "get_crypto_news", arguments: '{"coin":"BTC","limit":3}' }] },
      { model: "m", content: "**BTC** đang tăng.", toolCalls: [] }
    ]);
    const toolbox = fakeToolbox();
    const events: AiChatToolEvent[] = [];
    const deltas: string[] = [];

    const answer = await new AiChatService({ llm, defaultModel: "m", timeoutMs: 5_000 }).reply({
      context: context(),
      turns: [{ role: "user", content: "Phân tích BTC kèm tin" }],
      model: "m",
      onDelta: (text) => deltas.push(text),
      tools: toolbox,
      onTool: (event) => events.push(event)
    });

    expect(answer.content).toBe("**BTC** đang tăng.");
    expect(deltas).toEqual(["**BTC** đang tăng."]);
    expect(toolbox.marketAnalysis).toHaveBeenCalledWith("BTCUSDT");
    expect(toolbox.news).toHaveBeenCalledWith({ coin: "BTC", keywords: [], limit: 3 });
    expect(events.map((event) => `${event.name}:${event.status}`)).toEqual(["get_market_analysis:start", "get_market_analysis:done", "get_crypto_news:start", "get_crypto_news:done"]);
    // The second round carries both tool results back to the model.
    const second = llm.requests[1]!;
    expect(second.messages.filter((message) => message.role === "tool").map((message) => ("toolCallId" in message ? message.toolCallId : ""))).toEqual(["a", "b"]);
  });

  it("returns a rejected order to the model so it can explain why", async () => {
    const llm = new ScriptedLlm([
      { model: "m", content: "", toolCalls: [{ id: "o", name: "propose_order", arguments: '{"symbol":"BTCUSDT","side":"long","stopLoss":101,"takeProfit":120,"quantity":null,"reason":"test"}' }] },
      { model: "m", content: "SL phải thấp hơn giá.", toolCalls: [] }
    ]);
    const toolbox = fakeToolbox({ ok: false, code: "PRICE_OUTSIDE_SL_TP", reason: "A LONG needs stopLoss < price < takeProfit" });
    const events: AiChatToolEvent[] = [];

    await new AiChatService({ llm, defaultModel: "m", timeoutMs: 5_000 }).reply({ context: context(), turns: [{ role: "user", content: "Đặt lệnh BTC" }], model: "m", onDelta: () => undefined, tools: toolbox, onTool: (event) => events.push(event) });

    expect(toolbox.proposeOrder).toHaveBeenCalledWith({ symbol: "BTCUSDT", side: "LONG", stopLoss: 101, takeProfit: 120, quantity: null, reason: "test" });
    expect(events.at(-1)).toMatchObject({ name: "propose_order", status: "error", detail: "PRICE_OUTSIDE_SL_TP: A LONG needs stopLoss < price < takeProfit" });
    const toolMessage = llm.requests[1]!.messages.find((message) => message.role === "tool");
    expect(toolMessage && "content" in toolMessage ? toolMessage.content : "").toContain("PRICE_OUTSIDE_SL_TP");
  });

  it("forces a text answer after the last tool round", async () => {
    const call = { model: "m", content: "", toolCalls: [{ id: "x", name: "get_crypto_news", arguments: "{}" }] };
    const llm = new ScriptedLlm([...Array.from({ length: AI_CHAT_MAX_TOOL_ROUNDS }, () => call), { model: "m", content: "Hết công cụ.", toolCalls: [] }]);

    const answer = await new AiChatService({ llm, defaultModel: "m", timeoutMs: 5_000 }).reply({ context: context(), turns: [{ role: "user", content: "tin" }], model: "m", onDelta: () => undefined, tools: fakeToolbox() });

    expect(answer.content).toBe("Hết công cụ.");
    expect(llm.requests.at(-1)?.tools).toEqual([]);
    expect(llm.requests).toHaveLength(AI_CHAT_MAX_TOOL_ROUNDS + 1);
  });

  it("falls back to the streamed context-only answer when the server rejects tools", async () => {
    const llm = new ScriptedLlm([new LlmRequestError("LLM_HTTP_ERROR", "LLM HTTP 400: tools not supported")]);

    const answer = await new AiChatService({ llm, defaultModel: "m", timeoutMs: 5_000 }).reply({ context: context(), turns: [{ role: "user", content: "hi" }], model: "m", onDelta: () => undefined, tools: fakeToolbox() });

    expect(answer.content).toBe("streamed answer");
    expect(llm.streamed).toBe(1);
  });

  it("recognises major coins by name outside the watchlist", () => {
    expect(mentionedSymbols("Đặt thử 1 lệnh BTC", [])).toEqual(["BTCUSDT"]);
    expect(mentionedSymbols("gửi link giúp mình", [])).toEqual([]);
  });
});

describe("Chat orders", () => {
  it("sizes a user-given quantity exactly and ignores the automatic-trading switch", () => {
    const result = assessChatOrder(order({ quantity: 0.01 }), market({ config: config({ tradingEnabled: false }) }), 1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.risk.quantity).toBe(0.01);
    expect(result.plan).toMatchObject({ direction: "bullish", entry: 100_000, stopLoss: 99_000, takeProfit: 103_000, origin: "AI" });
  });

  it("sizes from riskPerTradeUsdt when the user gives no quantity", () => {
    const result = assessChatOrder(order({ quantity: null }), market({ config: config({ riskPerTradeUsdt: 20 }) }), 1);

    expect(result.ok && result.risk.quantity).toBe(0.02);
  });

  it("keeps the kill switch, SL/TP sides, the risk manager and the REAL lock", () => {
    expect(assessChatOrder(order(), market({ config: config({ killSwitch: true }) }), 1)).toMatchObject({ ok: false, code: "RISK_KILL_SWITCH" });
    expect(assessChatOrder(order({ stopLoss: 100_500 }), market(), 1)).toMatchObject({ ok: false, code: "PRICE_OUTSIDE_SL_TP" });
    expect(assessChatOrder(order({ takeProfit: 101_000 }), market(), 1)).toMatchObject({ ok: false, code: "RISK_RR_BELOW_MINIMUM" });
    expect(assessChatOrder(order(), market({ mode: "REAL" }), 1)).toMatchObject({ ok: false, code: "REAL_EXECUTION_LOCKED" });
    expect(assessChatOrder(order(), market({ livePrice: null }), 1)).toMatchObject({ ok: false, code: "LIVE_PRICE_UNAVAILABLE" });
    expect(assessChatOrder(order(), market({ executionBlocked: "READ_ONLY_SOAK_EXECUTION_BLOCKED" }), 1)).toMatchObject({ ok: false, code: "READ_ONLY_SOAK_EXECUTION_BLOCKED", reason: expect.stringContaining("read-only soak") });
  });

  it("places a confirmed proposal once, at the live price, with the size shown on the card", async () => {
    let price = 100_000;
    const submit = vi.fn(async (_account: string, _plan: EntryPlan, _risk: RiskDecision) => ({ executionIntentId: "intent-1" }));
    const desk = new AiChatOrderDesk({ loadMarket: async () => market({ livePrice: price }), submit });

    const proposed = await desk.propose(ACCOUNT, USER, order({ quantity: null }));
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.proposal).toMatchObject({ symbol: "BTCUSDT", side: "LONG", quantity: 0.02, sizing: "RISK", entry: 100_000 });
    expect(submit).not.toHaveBeenCalled();

    price = 100_200;
    const confirmed = await desk.confirm(ACCOUNT, USER, proposed.proposal.id);

    expect(confirmed).toMatchObject({ status: "SUBMITTED", executionIntentId: "intent-1", quantity: 0.02, entry: 100_200 });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[1]).toMatchObject({ entry: 100_200, origin: "AI" });
    await expect(desk.confirm(ACCOUNT, USER, proposed.proposal.id)).rejects.toMatchObject({ code: "CHAT_ORDER_ALREADY_USED" });
  });

  it("refuses another user's, an expired or a now-invalid proposal", async () => {
    let now = 1_000_000;
    let price = 100_000;
    const submit = vi.fn(async () => ({ executionIntentId: null }));
    const desk = new AiChatOrderDesk({ loadMarket: async () => market({ livePrice: price }), submit, now: () => now, ttlMs: 60_000 });

    const first = await desk.propose(ACCOUNT, USER, order());
    const second = await desk.propose(ACCOUNT, USER, order());
    if (!first.ok || !second.ok) throw new Error("fixture proposals should pass");

    await expect(desk.confirm(ACCOUNT, "someone-else", first.proposal.id)).rejects.toMatchObject({ code: "CHAT_ORDER_NOT_FOUND" });
    price = 98_000;
    await expect(desk.confirm(ACCOUNT, USER, first.proposal.id)).rejects.toMatchObject({ code: "PRICE_OUTSIDE_SL_TP" });
    now += 61_000;
    await expect(desk.confirm(ACCOUNT, USER, second.proposal.id)).rejects.toMatchObject({ code: "CHAT_ORDER_EXPIRED" });
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("Crypto news", () => {
  it("parses RSS items, filters by coin and sorts newest first", async () => {
    const service = new CryptoNewsService({
      feeds: [{ source: "Feed A", url: "https://a/rss" }, { source: "Feed B", url: "https://b/rss" }],
      fetchImpl: (async (url: string) =>
        url.includes("a/rss")
          ? new Response(rss([["Bitcoin ETF inflows jump", "Mon, 26 Oct 2026 08:00:00 GMT"], ["Solana upgrade ships", "Mon, 26 Oct 2026 09:00:00 GMT"]]))
          : new Response("down", { status: 503 })) as unknown as typeof fetch
    });

    const result = await service.latest({ coin: "BTCUSDT", limit: 5 });

    expect(result.items.map((item) => item.title)).toEqual(["Bitcoin ETF inflows jump"]);
    expect(result.items[0]).toMatchObject({ source: "Feed A", link: "https://news/0", publishedAt: "2026-10-26T08:00:00.000Z", summary: "Body & more" });
    expect(result.unavailable).toEqual(["Feed B"]);
    expect((await service.latest({})).items.map((item) => item.title)).toEqual(["Solana upgrade ships", "Bitcoin ETF inflows jump"]);
  });

  it("reads CDATA titles and decodes entities", () => {
    const items = parseRssItems(rss([["<![CDATA[Ethereum &amp; layer 2]]>", "Mon, 26 Oct 2026 08:00:00 GMT"]]), "X");
    expect(items[0]?.title).toBe("Ethereum & layer 2");
  });
});

describe("AI chat route with tools", () => {
  it("streams tool progress and a proposal card", async () => {
    const llm = new ScriptedLlm([
      { model: "m", content: "", toolCalls: [{ id: "o", name: "propose_order", arguments: '{"symbol":"BTCUSDT","side":"LONG","stopLoss":99000,"takeProfit":103000,"quantity":0.01,"reason":"test"}' }] },
      { model: "m", content: "Bấm **Xác nhận đặt lệnh** trên thẻ.", toolCalls: [] }
    ]);
    const desk = new AiChatOrderDesk({ loadMarket: async () => market(), submit: async () => ({ executionIntentId: null }) });
    const response = new FakeResponse();

    await streamAiChatReply({
      request: new EventEmitter() as unknown as IncomingMessage,
      response: response as unknown as ServerResponse,
      corsHeaders: {},
      account: { id: ACCOUNT, name: "Demo", mode: "DEMO" },
      settings: { watchlist: [] },
      turns: [{ role: "user", content: "Đặt lệnh BTC 0.01" }],
      aiChat: new AiChatService({ llm, defaultModel: "m", timeoutMs: 5_000 }),
      analyzeSymbol: async () => null,
      closedCandles: async () => [],
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      heartbeatMs: 10_000,
      tools: createAiChatToolbox({
        analyzeSymbol: async () => null,
        closedCandles: async () => [],
        livePrice: async () => 100_000,
        news: async () => ({ items: [] }),
        proposeOrder: (request) => desk.propose(ACCOUNT, USER, request)
      })
    });

    const events = response.events();
    expect(events.map((event) => event.event)).toEqual(["meta", "tool", "proposal", "tool", "delta", "done"]);
    expect(events.find((event) => event.event === "proposal")?.data).toMatchObject({ symbol: "BTCUSDT", side: "LONG", quantity: 0.01, sizing: "USER" });
  });
});

class ScriptedLlm implements StreamingLlmClient, ToolCallingLlmClient {
  requests: LlmToolRequest[] = [];
  streamed = 0;
  constructor(private readonly script: Array<LlmToolResponse | Error>) {}

  async completeWithTools(request: LlmToolRequest): Promise<LlmToolResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }

  async stream(_request: unknown, onDelta: (text: string) => void) {
    this.streamed += 1;
    onDelta("streamed answer");
    return { model: "m", content: "streamed answer" };
  }
}

function fakeToolbox(proposal: Awaited<ReturnType<AiChatToolbox["proposeOrder"]>> = { ok: false, code: "UNUSED", reason: "unused" }) {
  return {
    marketAnalysis: vi.fn(async (symbol: string) => ({ symbol, livePrice: 100_000 })),
    news: vi.fn(async () => ({ items: [] })),
    proposeOrder: vi.fn(async () => proposal)
  };
}

function context(): AiChatContext {
  return {
    now: "2026-10-27T00:00:00.000Z",
    account: { name: "Demo", mode: "DEMO" },
    settings: null,
    runtime: null,
    watchlist: [],
    recentEvents: [],
    aiDecisions: [],
    aiSteps: [],
    positions: [],
    openOrders: [],
    symbols: [],
    unavailable: []
  };
}

function order(overrides: Partial<ChatOrderRequest> = {}): ChatOrderRequest {
  return { symbol: "BTCUSDT", side: "LONG", stopLoss: 99_000, takeProfit: 103_000, quantity: 0.01, reason: "test", ...overrides };
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...defaultTradingSettings, maxMarginUsagePercent: 100, maxTotalMarginUsagePercent: 100, ...overrides } as AppConfig;
}

function market(overrides: Partial<ChatOrderMarket> = {}): ChatOrderMarket {
  return {
    mode: "DEMO",
    config: config(),
    livePrice: 100_000,
    availableBalance: 10_000,
    currentUsedMargin: 0,
    openPositions: 0,
    symbolOpenPositions: 0,
    symbolRules: btcRules(),
    drawdownPercent: 0,
    ...overrides
  };
}

function btcRules(): FuturesSymbolRules {
  return {
    symbol: "BTCUSDT",
    status: "TRADING",
    contractType: "PERPETUAL",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    pricePrecision: 1,
    quantityPrecision: 3,
    tickSize: 0.1,
    minPrice: 0.1,
    maxPrice: null,
    stepSize: 0.001,
    minQty: 0.001,
    maxQty: 100,
    minNotional: 5,
    maxLeverage: 125,
    maintenanceMarginBrackets: [
      { bracket: 1, notionalFloor: 0, notionalCap: 50_000, maintenanceMarginRatio: 0.004, cumulativeMaintenanceAmount: 0, initialLeverage: 125 },
      { bracket: 2, notionalFloor: 50_000, notionalCap: 250_000, maintenanceMarginRatio: 0.005, cumulativeMaintenanceAmount: 50, initialLeverage: 100 }
    ],
    supportedOrderTypes: ["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"]
  };
}

function rss(items: Array<[string, string]>): string {
  return `<?xml version="1.0"?><rss><channel>${items
    .map(([title, date], index) => `<item><title>${title}</title><link>https://news/${index}</link><pubDate>${date}</pubDate><description><![CDATA[<p>Body &amp; more</p>]]></description></item>`)
    .join("")}</channel></rss>`;
}

class FakeResponse extends EventEmitter {
  writableEnded = false;
  private readonly chunks: string[] = [];
  writeHead(): this {
    return this;
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): this {
    this.writableEnded = true;
    return this;
  }
  events(): Array<{ event: string; data: unknown }> {
    return this.chunks
      .join("")
      .split("\n\n")
      .filter((block) => block.startsWith("event: "))
      .map((block) => {
        const [eventLine, dataLine] = block.split("\n");
        return { event: eventLine?.slice("event: ".length) ?? "", data: JSON.parse(dataLine?.slice("data: ".length) ?? "null") as unknown };
      });
  }
}
