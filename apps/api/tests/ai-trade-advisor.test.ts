import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MarketScanner } from "../src/application/scanner/MarketScanner.js";
import { ExecutionCoordinator, clientOrderIds } from "../src/application/execution/ExecutionCoordinator.js";
import { MemoryExecutionIntentRepository } from "../src/infrastructure/execution/MemoryExecutionIntentRepository.js";
import { toExecutionSource } from "../src/infrastructure/execution/PostgresExecutionIntentRepository.js";
import { MemoryTradingRepository } from "../src/infrastructure/persistence/MemoryTradingRepository.js";
import { defaultTradingSettings, validateTradingSettings, type AppConfig } from "../src/application/config/AppConfig.js";
import { resolveSettingsInput } from "../src/application/config/TradingPresets.js";
import { AI_DECISION_AUDIT_TYPE, AiTradeAdvisor, validateAiDecision, type AiDecision } from "../src/application/ai/AiTradeAdvisor.js";
import { AI_DECISION_SYSTEM_PROMPT, buildAiDecisionMessages, buildBotAnalysisSnapshot, renderBotAnalysisSkillMarkdown } from "../src/application/ai/BotAnalysisSkill.js";
import { LlmRequestError, LocalLlmClient, extractJsonObject, type LlmChatRequest, type LlmChatResponse, type LlmClient } from "../src/application/ai/LocalLlmClient.js";
import type { ExecutionGateway, ExecutionOrderContext, SubmittedOrder } from "../src/application/ports/ExecutionGateway.js";
import type { DecisionLogger } from "../src/application/ports/Logger.js";
import type { EntryPlan } from "../src/domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../src/domain/risk/RiskDecision.js";
import type { Candle } from "../src/domain/market-data/Candle.js";
import type { FuturesSymbolRules } from "../src/domain/symbol/SymbolRules.js";

const ACCOUNT = "account-ai";

describe("Bot analysis skill", () => {
  it("builds a compact deterministic snapshot of the 7 conditions", async () => {
    const { scanner } = harness({ candles: solCandles(true), mode: "OFF", reply: skip });
    await scanner.scan();
    const engine = scanner.getEngine("SOLUSDT");
    if (!engine) throw new Error("missing engine");
    const state = engine.getState();
    const input = {
      diagnostic: engine.getSetupDiagnostic(),
      config: config({}),
      livePrice: 82.62,
      h1Candles: state.h1Candles,
      m5Candles: state.m5Candles,
      accountOpenPositions: 0,
      symbolOpenPositions: 0,
      at: 1_000
    };

    const snapshot = buildBotAnalysisSnapshot(input);

    expect(JSON.stringify(buildBotAnalysisSnapshot(input))).toBe(JSON.stringify(snapshot));
    expect(snapshot).toMatchObject({
      skill: { name: "smc-bot-analysis", version: 1 },
      symbol: "SOLUSDT",
      setupState: "ReadyToEnter",
      trend: "bullish",
      livePrice: 82.62,
      evidence: { passed: 7, total: 7, readyToEnter: true },
      risk: { minimumRiskReward: 2, riskPerTradeUsdt: 20, maxPositionPerSymbol: 1, aiMinConfidence: 0.7 },
      positions: { accountOpen: 0, symbolOpen: 0 },
      lastRejection: { code: "TRADING_DISABLED" }
    });
    expect(snapshot.conditions.map((condition) => condition.id)).toEqual(["h1-trend", "htf-fvg", "htf-fvg-first-touch", "m5-structure", "m5-fvg", "m5-fvg-pullback", "entry-plan"]);
    expect(snapshot.conditions.every((condition) => condition.passed)).toBe(true);
    expect(snapshot.conditions[1]?.values).toMatchObject({ lower: 81, upper: 83 });
    expect(snapshot.plan?.entry).toBeCloseTo(82.47);
    expect(snapshot.market.m5.candles.length).toBeLessThanOrEqual(12);
    expect(snapshot.market.h1.candles.length).toBeLessThanOrEqual(6);
    expect(snapshot.market.m5.candles[0]).toHaveLength(5);

    const messages = buildAiDecisionMessages(snapshot);
    expect(messages[0]).toEqual({ role: "system", content: AI_DECISION_SYSTEM_PROMPT });
    expect(AI_DECISION_SYSTEM_PROMPT).toContain('"enum":["ENTER","SKIP"]');
    expect(messages[1]?.content).toContain('"symbol":"SOLUSDT"');
  });

  it("keeps docs/ai/bot-analysis-skill.md in sync with the skill constants", () => {
    const doc = readFileSync(new URL("../../../docs/ai/bot-analysis-skill.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(doc).toBe(renderBotAnalysisSkillMarkdown());
  });
});

describe("AI decision validation", () => {
  const plan: EntryPlan = { direction: "bullish", entry: 100, structuralStopBoundary: 96, stopLossBuffer: 1, stopLoss: 95, takeProfit: 120, riskReward: 4, reason: "test" };
  const base = { symbol: "BTCUSDT", trend: "bullish" as const, livePrice: 101, plan, minimumRiskReward: 2, aiMinConfidence: 0.7, entryMode: "limit" as const };
  const enter = (overrides: Partial<AiDecision> = {}): AiDecision => ({
    action: "ENTER",
    symbol: "BTCUSDT",
    direction: "bullish",
    entry: 100,
    stopLoss: 95,
    takeProfit: 120,
    confidence: 0.8,
    reason: "valid",
    ...overrides
  });

  it("accepts a valid decision and may widen the stop", () => {
    const result = validateAiDecision(enter({ stopLoss: 94 }), base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ origin: "AI", direction: "bullish", entry: 100, stopLoss: 94, takeProfit: 120, structuralStopBoundary: 96 });
  });

  it.each([
    ["SYMBOL_MISMATCH", enter({ symbol: "ETHUSDT" }), base],
    ["DIRECTION_MISMATCH", enter({ direction: "bearish", stopLoss: 105, takeProfit: 80 }), base],
    ["DIRECTION_MISMATCH", enter(), { ...base, trend: "neutral" as const }],
    ["INVALID_PRICE", enter({ entry: Number.NaN }), base],
    ["INVALID_PRICE", enter({ stopLoss: 0 }), base],
    ["INVALID_PRICE", enter({ takeProfit: -1 }), base],
    ["INVALID_PROTECTION_SIDE", enter({ stopLoss: 101 }), base],
    ["INVALID_PROTECTION_SIDE", enter({ takeProfit: 99 }), base],
    ["LIVE_PRICE_UNAVAILABLE", enter(), { ...base, livePrice: null }],
    ["PRICE_OUTSIDE_SL_TP", enter(), { ...base, livePrice: 94 }],
    ["PRICE_OUTSIDE_SL_TP", enter(), { ...base, livePrice: 120 }],
    ["RR_BELOW_MINIMUM", enter({ takeProfit: 105 }), base],
    // MARKET fills at the live price, so RR is measured from there.
    ["RR_BELOW_MINIMUM", enter({ takeProfit: 112 }), { ...base, livePrice: 104, entryMode: "market" as const }],
    ["INVALID_CONFIDENCE", enter({ confidence: Number.NaN }), base],
    ["INVALID_CONFIDENCE", enter({ confidence: 1.5 }), base],
    ["LOW_CONFIDENCE", enter({ confidence: 0.5 }), base],
    ["SL_TIGHTER_THAN_STRUCTURE", enter({ stopLoss: 96 }), base]
  ])("rejects %s", (code, decision, input) => {
    const result = validateAiDecision(decision, input);
    expect(result).toMatchObject({ ok: false, code });
  });

  it("checks the short side mirrored", () => {
    const shortPlan: EntryPlan = { ...plan, direction: "bearish", entry: 100, structuralStopBoundary: 104, stopLoss: 105, takeProfit: 80 };
    const input = { ...base, trend: "bearish" as const, livePrice: 99, plan: shortPlan };
    expect(validateAiDecision(enter({ direction: "bearish", stopLoss: 106, takeProfit: 80 }), input).ok).toBe(true);
    expect(validateAiDecision(enter({ direction: "bearish", stopLoss: 104.5, takeProfit: 80 }), input)).toMatchObject({ ok: false, code: "SL_TIGHTER_THAN_STRUCTURE" });
  });
});

describe("AI trade advisor in the scan flow", () => {
  it("ADVISORY records the decision and never submits", async () => {
    const h = harness({ candles: solCandles(true), mode: "ADVISORY", reply: enterFromPlan });
    await h.scanner.scan();
    await h.scanner.whenAiIdle();

    expect(h.llm.calls).toHaveLength(1);
    expect(h.delegate.calls).toHaveLength(0);
    expect(await h.decisions()).toEqual([expect.objectContaining({ outcome: "ADVISORY", accepted: true, symbol: "SOLUSDT", effectiveMode: "ADVISORY" })]);
    expect(await h.repository.listByAccount(ACCOUNT)).toHaveLength(0);
  });

  it("AUTO submits through the engine gateway with origin AI, smc_ai client ids and intent source AI", async () => {
    const h = harness({ candles: solCandles(true), mode: "OFF", reply: enterFromPlan });
    await h.scanner.scan();
    expect(h.llm.calls).toHaveLength(0);

    h.scanner.updateConfig(config({ aiTradingMode: "AUTO", tradingEnabled: true }));
    await h.scanner.scan();
    await h.scanner.whenAiIdle();

    expect(h.delegate.calls).toHaveLength(1);
    const call = h.delegate.calls[0];
    expect(call?.plan.origin).toBe("AI");
    expect(call?.plan.entry).toBeCloseTo(82.62);
    expect(call?.risk.accepted).toBe(true);
    expect(call?.context?.clientEntryOrderId).toMatch(/^smc_ai[0-9a-f]{22}_E$/);
    expect(call?.context?.clientStopOrderId).toMatch(/^smc_ai[0-9a-f]{22}_S$/);
    expect(call?.context?.clientTakeProfitOrderId).toMatch(/^smc_ai[0-9a-f]{22}_T$/);

    const [intent] = await h.repository.listByAccount(ACCOUNT);
    expect(intent).toMatchObject({ source: "AI", symbol: "SOLUSDT", status: "PROTECTED" });
    expect(await h.decisions()).toEqual([expect.objectContaining({ outcome: "SUBMITTED", accepted: true, executionIntentId: intent?.id })]);
    // The symbol is now owned by the AI entry until reconciliation sees the position.
    expect(h.scanner.getEngine("SOLUSDT")?.getState().openPositions).toBe(1);
  });

  it("AUTO still goes through the engine risk manager (trading disabled blocks it)", async () => {
    const h = harness({ candles: solCandles(true), mode: "AUTO", reply: enterFromPlan });
    await h.scanner.scan();
    await h.scanner.whenAiIdle();

    expect(h.delegate.calls).toHaveLength(0);
    expect(await h.decisions()).toEqual([expect.objectContaining({ outcome: "REJECTED", rejectCode: "RISK_TRADING_DISABLED" })]);
  });

  it("a REAL account never auto-trades", async () => {
    const h = harness({ candles: solCandles(true), mode: "OFF", reply: enterFromPlan, accountMode: "REAL" });
    await h.scanner.scan();
    h.scanner.updateConfig(config({ aiTradingMode: "AUTO", tradingEnabled: true }));
    await h.scanner.scan();
    await h.scanner.whenAiIdle();

    expect(h.llm.calls).toHaveLength(1);
    expect(h.delegate.calls).toHaveLength(0);
    expect(await h.decisions()).toEqual([expect.objectContaining({ outcome: "ADVISORY", effectiveMode: "ADVISORY", accountMode: "REAL", rejectCode: "REAL_EXECUTION_LOCKED" })]);
  });

  it("does not add an AI order when the engine entered on the same candle", async () => {
    const h = harness({ candles: solCandles(true), mode: "AUTO", reply: enterFromPlan, tradingEnabled: true });
    await h.scanner.scan();
    await h.scanner.whenAiIdle();

    expect(h.delegate.calls).toHaveLength(1);
    expect(h.delegate.calls[0]?.plan.origin).toBeUndefined();
    expect(h.delegate.calls[0]?.context?.clientEntryOrderId).toMatch(/^smc_[0-9a-f]{24}_E$/);
    expect(h.llm.calls).toHaveLength(0);
    expect((await h.repository.listByAccount(ACCOUNT))[0]?.source).toBe("BOT");
  });

  it("refuses to submit while the symbol has an open execution intent", async () => {
    const h = harness({ candles: solCandles(true), mode: "OFF", reply: enterFromPlan });
    await h.scanner.scan();
    await h.repository.createOrGet({
      id: "00000000-0000-4000-8000-000000000001",
      tradingAccountId: ACCOUNT,
      symbol: "SOLUSDT",
      side: "long",
      setupKey: "existing",
      entryType: "market",
      requestedEntry: 82,
      requestedStopLoss: 81,
      requestedTakeProfit: 90,
      quantity: 1,
      clientEntryOrderId: "smc_existing_E",
      clientStopOrderId: "smc_existing_S",
      clientTakeProfitOrderId: "smc_existing_T"
    });
    h.scanner.updateConfig(config({ aiTradingMode: "AUTO", tradingEnabled: true }));
    await h.scanner.scan();
    await h.scanner.whenAiIdle();

    expect(h.delegate.calls).toHaveLength(0);
    expect(await h.decisions()).toEqual([expect.objectContaining({ outcome: "REJECTED", rejectCode: "DUPLICATE_ENTRY_GUARD" })]);
  });

  it("records a rejected decision with the reason and does not submit", async () => {
    const h = harness({ candles: solCandles(true), mode: "OFF", reply: (snapshotPlan) => enterFromPlan(snapshotPlan, undefined, { confidence: 0.2 }) });
    await h.scanner.scan();
    h.scanner.updateConfig(config({ aiTradingMode: "AUTO", tradingEnabled: true }));
    await h.scanner.scan();
    await h.scanner.whenAiIdle();

    expect(h.delegate.calls).toHaveLength(0);
    expect(await h.decisions()).toEqual([expect.objectContaining({ outcome: "REJECTED", accepted: false, rejectCode: "LOW_CONFIDENCE" })]);
  });

  it("an LLM timeout or garbage JSON never breaks the scan", async () => {
    const timeout = harness({ candles: solCandles(true), mode: "ADVISORY", reply: () => Promise.reject(new LlmRequestError("LLM_TIMEOUT", "timed out")) });
    await expect(timeout.scanner.scan()).resolves.toBeUndefined();
    await timeout.scanner.whenAiIdle();
    expect(await timeout.decisions()).toEqual([expect.objectContaining({ outcome: "LLM_ERROR", rejectCode: "LLM_TIMEOUT" })]);
    expect(timeout.scanner.getWatchlistStatus()[0]?.state).toBe("ReadyToEnter");

    const garbage = harness({ candles: solCandles(true), mode: "ADVISORY", reply: () => ({ model: "fake", content: "sure! {not json at all" }) });
    await garbage.scanner.scan();
    await garbage.scanner.whenAiIdle();
    expect(await garbage.decisions()).toEqual([expect.objectContaining({ outcome: "LLM_ERROR", rejectCode: "INVALID_JSON" })]);
  });

  it("does not wait for a slow model before finishing the scan", async () => {
    let release: (value: LlmChatResponse) => void = () => undefined;
    const pending = new Promise<LlmChatResponse>((resolve) => {
      release = resolve;
    });
    const h = harness({ candles: solCandles(true), mode: "ADVISORY", reply: () => pending });
    await h.scanner.scan();

    // The scan has returned while the model is still thinking.
    await vi.waitFor(() => expect(h.llm.calls).toHaveLength(1));
    expect(h.scanner.getWatchlistStatus()[0]?.state).toBe("ReadyToEnter");
    expect(await h.decisions()).toHaveLength(0);
    release({ model: "fake", content: JSON.stringify({ action: "SKIP", symbol: "SOLUSDT", direction: "bullish", entry: 0, stopLoss: 0, takeProfit: 0, confidence: 0.1, reason: "wait" }) });
    await h.scanner.whenAiIdle();
    expect(await h.decisions()).toEqual([expect.objectContaining({ outcome: "SKIPPED", accepted: false })]);
  });

  it("consults at most once per symbol per closed M5 candle", async () => {
    const data = new StaticMarketData(solCandles(false));
    const h = harness({ data, mode: "ADVISORY", reply: skip });
    await h.scanner.scan();
    await h.scanner.whenAiIdle();
    expect(h.scanner.getSetupDiagnostic("SOLUSDT")?.evidenceCount).toBe(5);
    expect(h.llm.calls).toHaveLength(1);

    await h.scanner.scan();
    await h.scanner.whenAiIdle();
    expect(h.llm.calls).toHaveLength(1);

    data.setCandles([...solCandles(false), candle("SOLUSDT", "M5", 12, 82.62, 82.7, 82.55, 82.65)]);
    await h.scanner.scan();
    await h.scanner.whenAiIdle();
    expect(h.llm.calls).toHaveLength(2);
  });

  it("does not consult the model below 5/7 evidence or when OFF", async () => {
    const early = harness({ candles: solCandles(false).slice(0, 5), mode: "ADVISORY", reply: skip });
    await early.scanner.scan();
    await early.scanner.whenAiIdle();
    expect(early.llm.calls).toHaveLength(0);

    const off = harness({ candles: solCandles(true), mode: "OFF", reply: skip });
    await off.scanner.scan();
    await off.scanner.whenAiIdle();
    expect(off.llm.calls).toHaveLength(0);
  });
});

describe("Execution origin", () => {
  it("round-trips the intent source in the memory repository", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const input = {
      tradingAccountId: ACCOUNT,
      symbol: "BTCUSDT",
      side: "long" as const,
      entryType: "market" as const,
      requestedEntry: 100,
      requestedStopLoss: 95,
      requestedTakeProfit: 110,
      quantity: 1,
      clientEntryOrderId: "smc_x_E",
      clientStopOrderId: "smc_x_S",
      clientTakeProfitOrderId: "smc_x_T"
    };
    await repository.createOrGet({ ...input, id: "ai-1", setupKey: "ai", source: "AI" });
    await repository.createOrGet({ ...input, id: "bot-1", setupKey: "bot" });
    await repository.transitionStatus("ai-1", ["CREATED"], "RISK_APPROVED");

    const intents = await repository.listByAccount(ACCOUNT);
    expect(intents.find((intent) => intent.id === "ai-1")?.source).toBe("AI");
    expect(intents.find((intent) => intent.id === "bot-1")?.source).toBe("BOT");
    expect((await repository.findBySetupKey(ACCOUNT, "ai"))?.source).toBe("AI");
  });

  it("maps Postgres source values without collapsing AI to BOT", () => {
    expect(toExecutionSource("AI")).toBe("AI");
    expect(toExecutionSource("EXTERNAL")).toBe("EXTERNAL");
    expect(toExecutionSource(null)).toBe("BOT");
    expect(toExecutionSource("BOT")).toBe("BOT");
  });

  it("keeps AI client order ids in the smc_ format reconciliation expects", () => {
    const ids = clientOrderIds("0123abcd-4567-4890-abcd-ef0123456789", "AI");
    expect(ids).toEqual({ entry: "smc_ai0123abcd45674890abcdef_E", stop: "smc_ai0123abcd45674890abcdef_S", takeProfit: "smc_ai0123abcd45674890abcdef_T" });
    expect(ids.entry.length).toBeLessThanOrEqual(36);
    expect(clientOrderIds("0123abcd-4567-4890-abcd-ef0123456789").entry).toBe("smc_0123abcd45674890abcdef01_E");
  });
});

describe("AI settings", () => {
  it("defaults to OFF and validates the AI fields", () => {
    expect(validateTradingSettings({})).toMatchObject({ aiTradingMode: "OFF", aiModel: "", aiMinConfidence: 0.7 });
    expect(() => validateTradingSettings({ aiTradingMode: "YOLO" })).toThrow();
    expect(() => validateTradingSettings({ aiMinConfidence: 1.5 })).toThrow();
  });

  it("simple mode keeps the AI fields and lets the user change aiTradingMode", () => {
    const current = validateTradingSettings({ aiTradingMode: "ADVISORY", aiModel: "cx/custom", aiMinConfidence: 0.85 });
    const saved = validateTradingSettings(resolveSettingsInput({ settingsMode: "simple", riskLevel: 2, aiTradingMode: "AUTO", aiModel: "ignored", aiMinConfidence: 0.1 }, current));
    expect(saved).toMatchObject({ settingsMode: "simple", aiTradingMode: "AUTO", aiModel: "cx/custom", aiMinConfidence: 0.85 });
  });
});

describe("Local LLM client", () => {
  it("extracts JSON from fenced or noisy model output", () => {
    expect(extractJsonObject('<think>{"x":1}</think>```json\n{"action":"SKIP"}\n```')).toEqual({ action: "SKIP" });
    expect(extractJsonObject('Here: {"action":"ENTER","reason":"a } brace"} done')).toEqual({ action: "ENTER", reason: "a } brace" });
    expect(extractJsonObject("no json")).toBeNull();
  });

  it("posts an OpenAI-compatible JSON-mode request", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const client = new LocalLlmClient({ baseUrl: "http://localhost:20128/v1", apiKey: "secret", timeoutMs: 1_000 }, async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({ model: "cx/gpt-5.6-sol", choices: [{ message: { content: '{"action":"SKIP"}' } }] }), { status: 200 });
    });

    const response = await client.complete({ model: "cx/gpt-5.6-sol", messages: [{ role: "user", content: "hi" }], jsonMode: true });

    expect(response).toEqual({ model: "cx/gpt-5.6-sol", content: '{"action":"SKIP"}' });
    expect(requests[0]?.url).toBe("http://localhost:20128/v1/chat/completions");
    expect(requests[0]?.body).toMatchObject({ model: "cx/gpt-5.6-sol", response_format: { type: "json_object" }, stream: false });
    expect(requests[0]?.headers.authorization).toBe("Bearer secret");
  });

  it("times out instead of hanging", async () => {
    const client = new LocalLlmClient({ baseUrl: "http://llm", apiKey: null, timeoutMs: 20 }, (_input, init) =>
      new Promise<Response>((_resolve, rejectRequest) => {
        init?.signal?.addEventListener("abort", () => rejectRequest(new Error("aborted")));
      })
    );
    await expect(client.complete({ model: "m", messages: [] })).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
  });
});

// --- harness ---------------------------------------------------------------------------------

type Reply = (plan: EntryPlan | null, request: LlmChatRequest) => Promise<LlmChatResponse> | LlmChatResponse;

function harness(options: {
  candles?: Candle[];
  data?: StaticMarketData;
  mode: AppConfig["aiTradingMode"];
  reply: Reply;
  tradingEnabled?: boolean;
  accountMode?: "DEMO" | "REAL";
}) {
  const data = options.data ?? new StaticMarketData(options.candles ?? []);
  data.livePrice = 82.62;
  const repository = new MemoryExecutionIntentRepository();
  const delegate = new SpyDelegate();
  const execution = new ExecutionCoordinator({
    tradingAccountId: ACCOUNT,
    mode: "DEMO",
    entryType: "market",
    repository,
    delegate,
    logger: fakeLogger(),
    retry: { maxAttempts: 1, baseDelayMs: 0 },
    runtimeReady: () => true
  });
  let scanner: MarketScanner | null = null;
  const llm = new FakeLlm((request) => options.reply(scanner?.getSetupDiagnostic("SOLUSDT")?.entryPlan ?? null, request));
  const advisor = new AiTradeAdvisor({
    tradingAccountId: ACCOUNT,
    accountMode: options.accountMode ?? "DEMO",
    llm,
    defaultModel: "cx/gpt-5.6-sol",
    repository,
    execution,
    logger: fakeLogger()
  });
  scanner = new MarketScanner(
    config({ aiTradingMode: options.mode, tradingEnabled: options.tradingEnabled ?? false }),
    new MemoryTradingRepository(),
    execution,
    fakeLogger(),
    data as never,
    null,
    async () => solRules(),
    null,
    { accountId: ACCOUNT },
    advisor
  );
  return {
    scanner,
    llm,
    delegate,
    repository,
    decisions: async () => (await repository.listAuditEvents(ACCOUNT, undefined, 100, AI_DECISION_AUDIT_TYPE)).map((event) => ({ ...event.metadata, executionIntentId: event.executionIntentId }))
  };
}

function enterFromPlan(plan: EntryPlan | null, _request?: LlmChatRequest, overrides: Record<string, unknown> = {}): LlmChatResponse {
  if (!plan) throw new Error("fixture should have a plan");
  return {
    model: "fake-model",
    content: `\`\`\`json\n${JSON.stringify({
      action: "ENTER",
      symbol: "SOLUSDT",
      direction: plan.direction,
      entry: plan.entry,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      confidence: 0.9,
      reason: "All 7 conditions passed",
      ...overrides
    })}\n\`\`\``
  };
}

function skip(): LlmChatResponse {
  return { model: "fake-model", content: JSON.stringify({ action: "SKIP", symbol: "SOLUSDT", direction: "bullish", entry: 0, stopLoss: 0, takeProfit: 0, confidence: 0.3, reason: "wait for trigger" }) };
}

class FakeLlm implements LlmClient {
  calls: LlmChatRequest[] = [];
  constructor(private readonly reply: (request: LlmChatRequest) => Promise<LlmChatResponse> | LlmChatResponse) {}
  async complete(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.calls.push(request);
    return this.reply(request);
  }
}

class SpyDelegate implements ExecutionGateway {
  calls: Array<{ plan: EntryPlan; risk: RiskDecision; context: ExecutionOrderContext | undefined }> = [];
  async submitBracketOrder(plan: EntryPlan, risk: RiskDecision, context?: ExecutionOrderContext): Promise<SubmittedOrder> {
    this.calls.push({ plan, risk, context });
    return {
      orderId: `entry-${this.calls.length}`,
      stopLossOrderId: "sl",
      takeProfitOrderId: "tp",
      clientEntryOrderId: context?.clientEntryOrderId ?? "",
      clientStopOrderId: context?.clientStopOrderId ?? "",
      clientTakeProfitOrderId: context?.clientTakeProfitOrderId ?? "",
      mode: "testnet"
    };
  }
}

function config(overrides: Partial<AppConfig>): AppConfig {
  return {
    ...defaultTradingSettings,
    symbol: "SOLUSDT",
    watchlist: ["SOLUSDT"],
    emaPeriod: 3,
    swingLeft: 1,
    swingRight: 1,
    port: 8787,
    executionMode: "testnet",
    logLevel: "info",
    corsOrigins: ["http://localhost:5173"],
    databaseUrl: undefined,
    sessionSecret: "test-session-secret-with-at-least-thirty-two-chars",
    binanceCredentialEncryptionKey: "1111111111111111111111111111111111111111111111111111111111111111",
    binanceApiKey: undefined,
    binanceApiSecret: undefined,
    binanceTestnet: true,
    reconciliationIntervalMs: 30_000,
    binanceRetryMaxAttempts: 1,
    binanceRetryBaseDelayMs: 0,
    postgresPoolMax: 2,
    realLiveExecutionEnabled: false,
    ...overrides
  } as AppConfig;
}

// Same fixture as scanner-lifecycle: H1 FVG [81, 83] touched, M5 BOS, M5 FVG [82.45, 82.47], pullback on candle 12.
function solCandles(includePullback: boolean): Candle[] {
  return [
    candle("SOLUSDT", "H1", 1, 80, 81, 79, 80),
    candle("SOLUSDT", "H1", 2, 81, 82, 80, 81),
    candle("SOLUSDT", "H1", 3, 84, 86, 83, 85),
    candle("SOLUSDT", "H1", 4, 85, 85.5, 81.4, 85),
    candle("SOLUSDT", "M5", 5, 100, 101, 99, 100),
    candle("SOLUSDT", "M5", 6, 105, 110, 104, 108),
    candle("SOLUSDT", "M5", 7, 103, 105, 101, 102),
    candle("SOLUSDT", "M5", 8, 108, 112, 107, 111),
    candle("SOLUSDT", "M5", 9, 82.4, 82.45, 82.38, 82.42),
    candle("SOLUSDT", "M5", 10, 82.43, 82.46, 82.4, 82.44),
    candle("SOLUSDT", "M5", 11, 82.5, 82.7, 82.47, 82.6),
    ...(includePullback ? [candle("SOLUSDT", "M5", 12, 82.62, 82.68, 82.46, 82.62)] : [])
  ];
}

function candle(symbol: string, timeframe: Candle["timeframe"], openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { symbol, timeframe, openTime, closeTime: openTime * 60_000, open, high, low, close, volume: 1, isClosed: true };
}

class StaticMarketData {
  livePrice: number | null = null;
  constructor(private candles: Candle[]) {}
  setCandles(candles: Candle[]): void {
    this.candles = candles;
  }
  async getClosedCandles(symbol: string, timeframe: "H1" | "M5", limit: number): Promise<Candle[]> {
    return this.candles.filter((item) => item.symbol === symbol && item.timeframe === timeframe).slice(-limit);
  }
  async getLastPrice(): Promise<number | null> {
    return this.livePrice;
  }
}

function solRules(): FuturesSymbolRules {
  return {
    symbol: "SOLUSDT",
    status: "TRADING",
    contractType: "PERPETUAL",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    pricePrecision: 2,
    quantityPrecision: 2,
    tickSize: 0.1,
    minPrice: 0.01,
    maxPrice: null,
    stepSize: 0.01,
    minQty: 0.01,
    maxQty: 100_000,
    minNotional: 5,
    maxLeverage: 75,
    maintenanceMarginBrackets: [{ bracket: 1, notionalFloor: 0, notionalCap: null, maintenanceMarginRatio: 0.005, cumulativeMaintenanceAmount: 0, initialLeverage: 75 }],
    supportedOrderTypes: ["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"]
  };
}

function fakeLogger(): DecisionLogger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}
