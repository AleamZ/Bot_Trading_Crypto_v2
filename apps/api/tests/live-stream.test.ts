import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { AiProgressStep } from "../src/application/ai/AiTradeAdvisor.js";
import { AI_STEP_HISTORY, LiveUpdateHub, type LiveChange } from "../src/application/runtime/LiveUpdateHub.js";
import type { LiveMonitorState, TradingRuntimeManager } from "../src/application/runtime/TradingRuntimeManager.js";
import type { DecisionLogger } from "../src/application/ports/Logger.js";
import { streamAccountLiveUpdates } from "../src/presentation/http/LiveStream.js";

const ACCOUNT = "account-live";

describe("LiveUpdateHub", () => {
  it("delivers changes per account and stops after unsubscribe", () => {
    const hub = new LiveUpdateHub();
    const received: LiveChange[] = [];
    const other: LiveChange[] = [];
    const unsubscribe = hub.subscribe(ACCOUNT, (change) => received.push(change));
    hub.subscribe("other-account", (change) => other.push(change));

    hub.publish(ACCOUNT, { topic: "scan", symbol: "BTCUSDT" });
    unsubscribe();
    hub.publish(ACCOUNT, { topic: "reconcile" });

    expect(received).toEqual([{ topic: "scan", symbol: "BTCUSDT" }]);
    expect(other).toEqual([]);
    expect(hub.listenerCount(ACCOUNT)).toBe(0);
  });

  it("isolates a throwing listener", () => {
    const hub = new LiveUpdateHub();
    const received: LiveChange[] = [];
    hub.subscribe(ACCOUNT, () => {
      throw new Error("broken stream");
    });
    hub.subscribe(ACCOUNT, (change) => received.push(change));

    expect(() => hub.publish(ACCOUNT, { topic: "config" })).not.toThrow();
    expect(received).toEqual([{ topic: "config" }]);
  });

  it("keeps the most recent AI steps per account and publishes each one", () => {
    const hub = new LiveUpdateHub();
    const received: LiveChange[] = [];
    hub.subscribe(ACCOUNT, (change) => received.push(change));
    for (let index = 0; index < AI_STEP_HISTORY + 5; index += 1) hub.recordAiStep(ACCOUNT, step(index));

    const recent = hub.recentAiSteps(ACCOUNT);
    expect(recent).toHaveLength(AI_STEP_HISTORY);
    expect(recent[0]?.id).toBe("step-5");
    expect(recent.at(-1)?.id).toBe(`step-${AI_STEP_HISTORY + 4}`);
    expect(received).toHaveLength(AI_STEP_HISTORY + 5);
    expect(hub.recentAiSteps("other-account")).toEqual([]);
  });

  it("closeAccount tells streams to close and forgets the account", () => {
    const hub = new LiveUpdateHub();
    const received: LiveChange[] = [];
    hub.subscribe(ACCOUNT, (change) => received.push(change));
    hub.recordAiStep(ACCOUNT, step(1));

    hub.closeAccount(ACCOUNT);

    expect(received.at(-1)).toEqual({ topic: "closed" });
    expect(hub.listenerCount(ACCOUNT)).toBe(0);
    expect(hub.recentAiSteps(ACCOUNT)).toEqual([]);
  });
});

describe("account live stream (SSE)", () => {
  it("opens an event stream with the current monitor state, decisions and recent AI steps", async () => {
    const h = streamHarness();
    h.runtime.live.recordAiStep(ACCOUNT, step(1));
    await h.open();

    expect(h.response.status).toBe(200);
    expect(h.response.headers).toMatchObject({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "x-request-id": "req-1"
    });
    expect(h.response.body()).toContain("retry: 5000");
    expect(h.events().map((event) => event.event)).toEqual(["monitor", "store", "ai-decisions", "ai-steps"]);
    expect(h.last("monitor")).toEqual({
      engine: { setupState: "WaitingLtfFvg" },
      watchlistRows: [{ symbol: "BTCUSDT", status: "Monitoring" }],
      runtimeHealth: { state: "READY" },
      execution: { enabled: true, reason: "READY" }
    });
    expect(h.last("store")).toEqual({ store: { events: [] } });
    expect(h.last("ai-steps")).toEqual({ steps: [expect.objectContaining({ id: "step-1" })] });
  });

  it("pushes monitor changes after a scan, skips unchanged payloads and names the scanned symbols", async () => {
    const h = streamHarness();
    await h.open();

    h.state.watchlistStatus = [{ symbol: "BTCUSDT", status: "Ready" }] as never;
    h.runtime.live.publish(ACCOUNT, { topic: "scan", symbol: "BTCUSDT" });
    h.runtime.live.publish(ACCOUNT, { topic: "scan", symbol: "ETHUSDT" });
    await vi.waitFor(() => expect(h.events().filter((event) => event.event === "scanned")).toHaveLength(1));

    expect(h.events().filter((event) => event.event === "monitor")).toHaveLength(2);
    expect(h.last("monitor")).toMatchObject({ watchlistRows: [{ symbol: "BTCUSDT", status: "Ready" }] });
    // The store did not change, so it is not sent again.
    expect(h.events().filter((event) => event.event === "store")).toHaveLength(1);
    expect(h.last("scanned")).toMatchObject({ symbols: ["BTCUSDT", "ETHUSDT"] });
    // Both scans arrived in one burst and were read once.
    expect(h.runtime.getLiveState).toHaveBeenCalledTimes(2);
  });

  it("streams AI steps immediately and refreshes the decisions after a result", async () => {
    const h = streamHarness();
    await h.open();

    h.runtime.live.recordAiStep(ACCOUNT, step(2, "analyze"));
    expect(h.last("ai-step")).toMatchObject({ id: "step-2", stage: "analyze" });
    expect(h.runtime.listAiDecisions).toHaveBeenCalledTimes(1);

    h.decisions = [{ id: "decision-1", outcome: "SKIPPED" }];
    h.runtime.live.recordAiStep(ACCOUNT, step(3, "result"));
    await vi.waitFor(() => expect(h.events().filter((event) => event.event === "ai-decisions")).toHaveLength(2));
    expect(h.last("ai-decisions")).toEqual({ decisions: [{ id: "decision-1", outcome: "SKIPPED" }] });
  });

  it("closes the stream when the runtime goes away", async () => {
    const h = streamHarness();
    await h.open();

    h.runtime.live.closeAccount(ACCOUNT);

    expect(h.response.writableEnded).toBe(true);
    expect(h.runtime.live.listenerCount(ACCOUNT)).toBe(0);
  });

  it("ends the stream if the runtime can no longer be read", async () => {
    const h = streamHarness();
    await h.open();
    h.runtime.getLiveState.mockRejectedValueOnce(new Error("ACCOUNT_REMOVING"));

    h.runtime.live.publish(ACCOUNT, { topic: "reconcile" });

    await vi.waitFor(() => expect(h.response.writableEnded).toBe(true));
    expect(h.runtime.live.listenerCount(ACCOUNT)).toBe(0);
  });

  it("unsubscribes and stops the heartbeat when the browser disconnects", async () => {
    vi.useFakeTimers();
    try {
      const h = streamHarness();
      await h.open();
      vi.advanceTimersByTime(40);
      expect(h.response.body()).toContain(": ping");

      h.request.emit("close");
      const length = h.response.body().length;
      vi.advanceTimersByTime(100);

      expect(h.response.body().length).toBe(length);
      expect(h.runtime.live.listenerCount(ACCOUNT)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails before writing anything when the runtime is unavailable, so the caller can answer with JSON", async () => {
    const h = streamHarness();
    h.runtime.getLiveState.mockRejectedValueOnce(new Error("LOCAL_TRADING_RUNTIME_DISABLED"));

    await expect(h.open()).rejects.toThrow("LOCAL_TRADING_RUNTIME_DISABLED");
    expect(h.response.status).toBeNull();
    expect(h.response.body()).toBe("");
    expect(h.runtime.live.listenerCount(ACCOUNT)).toBe(0);
  });
});

function step(index: number, stage: "analyze" | "result" = "analyze"): AiProgressStep {
  const base = { id: `step-${index}`, symbol: "BTCUSDT", at: 1_000 + index };
  return stage === "analyze"
    ? { ...base, stage, model: "fake", mode: "ADVISORY", setupState: "ReadyToEnter", evidence: 7, trend: "bullish", livePrice: 100 }
    : { ...base, stage, outcome: "SKIPPED", rejectCode: null, rejectReason: null, executionIntentId: null, latencyMs: 5 };
}

class FakeResponse extends EventEmitter {
  status: number | null = null;
  headers: Record<string, unknown> = {};
  writableEnded = false;
  private readonly chunks: string[] = [];

  writeHead(status: number, headers: Record<string, unknown>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): this {
    this.writableEnded = true;
    this.emit("close");
    return this;
  }

  body(): string {
    return this.chunks.join("");
  }
}

function streamHarness() {
  const live = new LiveUpdateHub();
  const state: LiveMonitorState = {
    engine: { setupState: "WaitingLtfFvg" },
    store: { events: [] },
    watchlistStatus: [{ symbol: "BTCUSDT", status: "Monitoring" }] as never,
    runtimeHealth: { state: "READY" } as never,
    execution: { enabled: true, reason: "READY" } as never
  };
  const harness = {
    state,
    decisions: [] as Array<Record<string, unknown>>,
    request: new EventEmitter(),
    response: new FakeResponse(),
    runtime: {
      live,
      getLiveState: vi.fn(async () => structuredClone(harness.state)),
      listAiDecisions: vi.fn(async () => harness.decisions)
    },
    open: () =>
      streamAccountLiveUpdates({
        request: harness.request as unknown as IncomingMessage,
        response: harness.response as unknown as ServerResponse,
        corsHeaders: { "x-request-id": "req-1" },
        accountId: ACCOUNT,
        runtimeManager: harness.runtime as unknown as TradingRuntimeManager,
        logger: silentLogger(),
        heartbeatMs: 20,
        flushDelayMs: 5
      }),
    events: () =>
      harness.response
        .body()
        .split("\n\n")
        .filter((block) => block.startsWith("event: "))
        .map((block) => {
          const [eventLine, dataLine] = block.split("\n");
          return { event: eventLine?.slice("event: ".length), data: JSON.parse(dataLine?.slice("data: ".length) ?? "null") as unknown };
        }),
    last: (event: string) => harness.events().filter((item) => item.event === event).at(-1)?.data
  };
  return harness;
}

function silentLogger(): DecisionLogger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}
