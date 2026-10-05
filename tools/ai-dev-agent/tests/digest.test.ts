import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregate, emptyDigest, normalizeErrorKey, renderDigest, summarizeDigest } from "../src/digest.js";
import { parseLogLine, type ParsedLogLine } from "../src/logs/parseLine.js";

const fixtures = join(import.meta.dirname, "fixtures");

function load(name: string, defaultLevel: "unknown" | "error" = "unknown"): ParsedLogLine[] {
  return readFileSync(join(fixtures, name), "utf8")
    .split("\n")
    .map((line) => parseLogLine(line, defaultLevel))
    .filter((line): line is ParsedLogLine => line !== null);
}

describe("digest aggregation", () => {
  const digest = aggregate(load("sample-error.log", "error"), aggregate(load("sample-out.log")));

  it("counts rejection codes and archive reasons", () => {
    expect(digest.entryRejected).toEqual({ MAX_OPEN_POSITIONS: 1, UNKNOWN: 1 });
    expect(digest.planRejected).toEqual({ PRICE_BEYOND_PROTECTION: 1 });
    expect(digest.planRejectedClassification).toEqual({ PERMANENT_CANDIDATE_INVALID: 1 });
    expect(digest.archiveReasons).toMatchObject({
      ENTRY_WINDOW_EXPIRED: 1,
      PRICE_BEYOND_PROTECTION: 1,
      TRIGGER_CLOSED_BEYOND_STOP: 1,
      HTF_CONTEXT_EXPIRED: 1
    });
  });

  it("counts funnel stages per symbol with reasons", () => {
    expect(digest.funnelTotals.LTF_FIRST_TOUCH_CONFIRMED).toBe(4);
    expect(digest.funnelBySymbol.BTCUSDT?.stages).toMatchObject({ LTF_FIRST_TOUCH_CONFIRMED: 2, ENTRY_PLAN_REJECTED: 1 });
    expect(digest.funnelBySymbol.BTCUSDT?.planRejectReasons).toEqual({ PRICE_BEYOND_PROTECTION: 1 });
    expect(digest.funnelBySymbol.ETHUSDT?.riskRejectReasons).toEqual({ MAX_OPEN_POSITIONS: 1 });
    expect(digest.funnelBySymbol.SOLUSDT?.stages.RISK_PASSED).toBe(1);
  });

  it("tracks trades, failures and protection issues", () => {
    expect(digest.trades).toEqual({ riskPassed: 1, executionFailed: 1, confirmations: 0, estimatedPlaced: 0 });
    expect(digest.executionFailures).toEqual({ PROTECTION_INCOMPLETE: 1 });
    expect(digest.protectionIssues).toBe(1);
    expect(digest.runtimeFailures).toEqual({ "reconciliation failed": 2, "bootstrap failed": 1 });
    expect(digest.scannerFailures).toBe(1);
  });

  it("deduplicates errors whose only difference is numbers/ips", () => {
    const reconciliation = digest.errors.find((sample) => sample.sample.startsWith("[RUNTIME] reconciliation failed"));
    expect(reconciliation?.count).toBe(2);
    const rejection = digest.errors.find((sample) => sample.sample.startsWith("Unhandled promise rejection"));
    expect(rejection?.count).toBe(2);
    expect(digest.errors.some((sample) => sample.sample.startsWith("at "))).toBe(false);
    expect(digest.stackFrames).toBe(1);
    const key = normalizeErrorKey("x 10.0.0.12:443 id 0b6f2c1e-1111-4222-8333-944455556666");
    expect(key).toContain("<uuid>");
    expect(key).not.toMatch(/\d/);
    expect(key).toBe(normalizeErrorKey("x 10.0.0.13:8443 id 1b6f2c1e-1111-4222-8333-944455556666"));
  });

  it("computes the time window and signal events", () => {
    expect(digest.window.from).toBe("2026-10-05T08:00:00.120Z");
    expect(digest.window.to).toBe("2026-10-05T11:06:00.000Z");
    expect(digest.signalEvents).toBeGreaterThan(10);
    expect(digest.totalLines).toBe(31);
  });

  it("renders within the character budget", () => {
    const full = renderDigest(digest, 10_000);
    expect(full).toContain("PRICE_BEYOND_PROTECTION");
    expect(full).toContain("dropoffs:");
    for (const budget of [3_000, 1_500, 800]) {
      expect(renderDigest(digest, budget).length).toBeLessThanOrEqual(budget);
    }
  });

  it("shrinks lists for very large digests", () => {
    const big = emptyDigest();
    const lines: ParsedLogLine[] = [];
    for (let i = 0; i < 300; i += 1) {
      lines.push(parseLogLine(`{"timestamp":"2026-10-05T08:00:00Z","level":"error","message":"Unique failure ${"x".repeat(i % 7)} kind-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}","error":"e"}`)!);
      lines.push(parseLogLine(`{"timestamp":"2026-10-05T08:00:00Z","level":"info","message":"[FUNNEL] a/SYM${i}USDT LIVE SCAN_EVALUATED"}`)!);
    }
    aggregate(lines, big);
    const text = renderDigest(big, 2_000);
    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(summarizeDigest(big)).toContain("lines=600");
  });
});
