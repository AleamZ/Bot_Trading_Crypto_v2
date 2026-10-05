import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCursorState, readNewLines, saveCursorState } from "../src/logs/logReader.js";
import { parseLogLine } from "../src/logs/parseLine.js";

describe("parseLogLine", () => {
  it("parses production JSON lines with a pm2 time prefix", () => {
    const line =
      '2026-10-05T08:05:00: {"timestamp":"2026-10-05T08:05:00.011Z","level":"warn","component":"api","message":"Entry plan rejected before risk manager","reason":"PRICE_BEYOND_PROTECTION","classification":"PERMANENT_CANDIDATE_INVALID"}';
    const parsed = parseLogLine(line);
    expect(parsed).toMatchObject({
      format: "json",
      level: "warn",
      timestamp: "2026-10-05T08:05:00.011Z",
      message: "Entry plan rejected before risk manager",
      context: { reason: "PRICE_BEYOND_PROTECTION", classification: "PERMANENT_CANDIDATE_INVALID" }
    });
    expect(parsed?.context).not.toHaveProperty("component");
  });

  it("parses production JSON without a prefix", () => {
    const parsed = parseLogLine('{"timestamp":"2026-10-05T08:00:00.000Z","level":"error","component":"api","message":"[SCANNER] scan failed","error":"boom"}');
    expect(parsed).toMatchObject({ format: "json", level: "error", message: "[SCANNER] scan failed", context: { error: "boom" } });
  });

  it("parses dev lines and splits the reason suffix", () => {
    const parsed = parseLogLine("[2026-10-05T11:01:00.000Z] WARN [RUNTIME] bootstrap failed: Cannot load exchange info: timeout");
    expect(parsed).toMatchObject({
      format: "dev",
      level: "warn",
      timestamp: "2026-10-05T11:01:00.000Z",
      message: "[RUNTIME] bootstrap failed",
      reasonSuffix: "Cannot load exchange info: timeout"
    });
  });

  it("parses dev funnel lines without reason", () => {
    const parsed = parseLogLine("[2026-10-05T11:00:00.000Z] INFO [FUNNEL] acc-2/BTCUSDT LIVE LTF_FIRST_TOUCH_CONFIRMED");
    expect(parsed).toMatchObject({ format: "dev", level: "info", message: "[FUNNEL] acc-2/BTCUSDT LIVE LTF_FIRST_TOUCH_CONFIRMED", reasonSuffix: null });
  });

  it("returns raw lines with the default level and handles CRLF / blanks", () => {
    expect(parseLogLine("TypeError: boom\r", "error")).toMatchObject({ format: "raw", level: "error", message: "TypeError: boom" });
    expect(parseLogLine("   ")).toBeNull();
    expect(parseLogLine("{not json", "unknown")).toMatchObject({ format: "raw", message: "{not json" });
  });
});

describe("readNewLines (cursor + rotation)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-agent-log-"));
    file = join(dir, "out.log");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null for a missing file", () => {
    expect(readNewLines(file, undefined, 1024)).toBeNull();
  });

  it("reads incrementally and keeps partial trailing lines for later", () => {
    writeFileSync(file, "line-1\nline-2\npart");
    const first = readNewLines(file, undefined, 1024)!;
    expect(first.lines).toEqual(["line-1", "line-2"]);
    expect(first.nextCursor.offset).toBe("line-1\nline-2\n".length);

    appendFileSync(file, "ial\nline-4\r\n");
    const second = readNewLines(file, first.nextCursor, 1024)!;
    expect(second.lines).toEqual(["partial", "line-4"]);
    expect(second.rotated).toBe(false);

    const third = readNewLines(file, second.nextCursor, 1024)!;
    expect(third.lines).toEqual([]);
  });

  it("restarts from 0 when the file was truncated", () => {
    writeFileSync(file, "aaaa\nbbbb\ncccc\n");
    const first = readNewLines(file, undefined, 1024)!;
    writeFileSync(file, "new\n");
    const second = readNewLines(file, first.nextCursor, 1024)!;
    expect(second.rotated).toBe(true);
    expect(second.lines).toEqual(["new"]);
  });

  it("detects rotation when a new file grew past the old offset (head hash changed)", () => {
    writeFileSync(file, "old-1\nold-2\n");
    const first = readNewLines(file, undefined, 1024)!;
    rmSync(file);
    writeFileSync(file, "NEW-1\nNEW-2\nNEW-3\nNEW-4\n");
    const second = readNewLines(file, first.nextCursor, 1024)!;
    expect(second.rotated).toBe(true);
    expect(second.lines).toEqual(["NEW-1", "NEW-2", "NEW-3", "NEW-4"]);
  });

  it("respects the byte budget and reports truncation", () => {
    writeFileSync(file, "0123456789\n0123456789\n0123456789\n");
    const first = readNewLines(file, undefined, 25)!;
    expect(first.lines).toEqual(["0123456789", "0123456789"]);
    expect(first.truncated).toBe(true);
    const second = readNewLines(file, first.nextCursor, 25)!;
    expect(second.lines).toEqual(["0123456789"]);
    expect(second.truncated).toBe(false);
  });

  it("persists cursor state atomically", () => {
    writeFileSync(file, "x\n");
    const chunk = readNewLines(file, undefined, 1024)!;
    const stateFile = join(dir, "state", "cursors.json");
    saveCursorState(stateFile, { [file]: chunk.nextCursor });
    expect(loadCursorState(stateFile)[file]?.offset).toBe(2);
    expect(loadCursorState(join(dir, "missing.json"))).toEqual({});
  });
});
