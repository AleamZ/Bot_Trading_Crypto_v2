import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SafeCommandRunner, type CommandResult, type CommandRunner, type RunOptions } from "../src/commandRunner.js";
import { buildConfig, type AgentConfig } from "../src/config.js";
import { AgentCycle, MEMORY_FILE } from "../src/cycle.js";
import { checkOpenPrGate } from "../src/github.js";
import type { ChatMessage, LlmClient } from "../src/llm.js";
import { loadMemory, memoryForPrompt, refreshPrOutcomes, saveMemory, emptyMemory } from "../src/memory.js";
import type { StepResult, Toolchain } from "../src/toolchain.js";

const NODE = process.execPath;
const fixtures = join(import.meta.dirname, "fixtures");
const TARGET = "apps/api/src/application/engine/TradingEngine.ts";
const TEST_FILE = "apps/api/tests/engine-archive.test.ts";

const GOOD_DIFF = [
  `diff --git a/${TARGET} b/${TARGET}`,
  `--- a/${TARGET}`,
  `+++ b/${TARGET}`,
  "@@ -1,2 +1,2 @@",
  " export const x = 1;",
  "-export const y = 2;",
  "+export const y = 3;",
  `diff --git a/${TEST_FILE} b/${TEST_FILE}`,
  "new file mode 100644",
  "--- /dev/null",
  `+++ b/${TEST_FILE}`,
  "@@ -0,0 +1,1 @@",
  "+it('works', () => {});",
  ""
].join("\n");

type Call = { command: string; args: string[]; cwd: string };

/** Fake git/gh: records every call and answers like a healthy repo. */
class FakeRunner implements CommandRunner {
  calls: Call[] = [];
  openPrs: unknown[] = [];
  prView: Record<number, unknown> = {};
  stagedDiff = GOOD_DIFF;
  statusPaths = [TARGET, TEST_FILE];
  ghFails = false;

  async run(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, args: [...args], cwd: options.cwd });
    const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
    if (command === "gh") {
      if (this.ghFails) return { code: 1, stdout: "", stderr: "gh: not authenticated" };
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify(this.openPrs));
      if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify(this.prView[Number(args[2])] ?? { state: "OPEN" }));
      if (args[0] === "pr" && args[1] === "create") return ok("https://github.com/tcuong2003/bot_trade_feature_binance/pull/42\n");
      if (args[0] === "label" && args[1] === "list") return ok("[]");
      return ok();
    }
    if (command === "git") {
      const sub = args[0];
      if (sub === "rev-parse" && args.includes("--verify")) return args[args.length - 1]?.startsWith("refs/heads/ai/") ? { code: 1, stdout: "", stderr: "" } : ok("abc\n");
      if (sub === "rev-parse" && args.includes("--abbrev-ref")) {
        const add = this.calls.find((call) => call.command === "git" && call.args[0] === "worktree" && call.args[1] === "add");
        return ok(`${add?.args[3] ?? "?"}\n`);
      }
      if (sub === "show") {
        const path = String(args[1]).split(":")[1];
        if (path === "trading_rules.md") return ok("# Rules\nRR >= 2");
        if (path === "docs/ai/bot-analysis-skill.md") return { code: 128, stdout: "", stderr: "missing" };
        return ok("export const x = 1;\nexport const y = 2;\n");
      }
      if (sub === "status") return ok(this.statusPaths.map((p) => ` M ${p}\0`).join(""));
      if (sub === "diff" && args.includes("--cached")) return ok(this.stagedDiff);
      if (sub === "diff" && args.includes("--name-only")) return ok(this.statusPaths.join("\n"));
      return ok();
    }
    return ok();
  }

  pushed(): Call[] {
    return this.calls.filter((call) => call.command === "git" && call.args[0] === "push");
  }

  prCreates(): Call[] {
    return this.calls.filter((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create");
  }
}

class FakeLlm implements LlmClient {
  prompts: ChatMessage[][] = [];
  constructor(private readonly responses: string[]) {}
  async complete(messages: ChatMessage[]): Promise<string> {
    this.prompts.push(messages);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("unexpected LLM call");
    return next;
  }
}

class FakeToolchain implements Toolchain {
  installs = 0;
  constructor(private readonly results: Array<{ typecheck: boolean; test: boolean }> = [{ typecheck: true, test: true }]) {}
  private current = 0;
  private step(ok: boolean, output: string): StepResult {
    return { ok, output, durationMs: 10 };
  }
  async install(): Promise<StepResult> {
    this.installs += 1;
    return this.step(true, "linked");
  }
  async typecheck(): Promise<StepResult> {
    const result = this.results[Math.min(this.current, this.results.length - 1)]!;
    this.current += 1;
    return this.step(result.typecheck, result.typecheck ? "" : "error TS2322: nope");
  }
  async test(): Promise<StepResult> {
    const result = this.results[Math.min(this.current - 1, this.results.length - 1)]!;
    return this.step(result.test, result.test ? "Tests 120 passed" : "FAIL engine.test.ts");
  }
  cleanup(): void {}
}

const DIAGNOSIS = JSON.stringify({
  summary: "Setups archived with PRICE_BEYOND_PROTECTION",
  findings: [{ title: "PRICE_BEYOND_PROTECTION archives valid setups", evidence: "planRejected=1", hypothesis: "stale protection" }],
  severity: "medium",
  codeChangeWarranted: true,
  proposal: "Re-evaluate protection using the trigger candle close",
  filesToRead: [TARGET, "apps/api/.env", "../../etc/passwd"]
});
const PATCH = JSON.stringify({ title: "fix(engine): re-evaluate protection on trigger close", body: "Root cause...", diff: GOOD_DIFF });

describe("AgentCycle", () => {
  let dir: string;
  let config: AgentConfig;
  let runner: FakeRunner;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-agent-cycle-"));
    copyFileSync(join(fixtures, "sample-out.log"), join(dir, "out.log"));
    config = {
      ...buildConfig({ MIN_NEW_LINES: "10", MIN_SIGNAL_EVENTS: "1000" }, join(dir, "pkg")),
      repoPath: dir,
      logPaths: [join(dir, "out.log")],
      stateDir: join(dir, "state"),
      reportsDir: join(dir, "reports"),
      worktreeDir: join(dir, "worktrees")
    };
    runner = new FakeRunner();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cycle = (llm: LlmClient, toolchain: Toolchain = new FakeToolchain(), overrides: Partial<AgentConfig> = {}) =>
    new AgentCycle({ config: { ...config, ...overrides }, runner: new SafeCommandRunner(runner, NODE), llm, toolchain, log: () => undefined, now: () => new Date(2026, 9, 5, 10, 30) });

  it("dry-run (default) runs checks but NEVER pushes or opens a PR", async () => {
    expect(config.dryRun).toBe(true);
    const llm = new FakeLlm([DIAGNOSIS, PATCH]);
    const result = await cycle(llm).run();
    expect(result.decision).toBe("dry-run");
    expect(result.branch).toBe("ai/20261005-1030-re-evaluate-protection-on-trigger-close");
    expect(runner.pushed()).toEqual([]);
    expect(runner.prCreates()).toEqual([]);
    expect(runner.calls.some((call) => call.command === "git" && call.args[0] === "commit")).toBe(false);
    // the work was really done up to the tests
    expect(runner.calls.some((call) => call.args[0] === "apply" && call.args[1] === "--check")).toBe(true);
    expect(runner.calls.some((call) => call.args[0] === "worktree" && call.args[1] === "remove")).toBe(true);
    expect(existsSync(result.reportPath!)).toBe(true);
    expect(readFileSync(result.reportPath!, "utf8")).toContain("AI-generated, requires human review");
    const memory = loadMemory(join(config.stateDir, MEMORY_FILE));
    expect(memory.runs.at(-1)?.decision).toBe("dry-run");
    expect(memory.hypotheses.at(-1)?.status).toBe("dry-run");
  });

  it("only reads allowed files requested by the LLM", async () => {
    await cycle(new FakeLlm([DIAGNOSIS, PATCH])).run();
    const shows = runner.calls.filter((call) => call.args[0] === "show").map((call) => call.args[1]);
    expect(shows).toContain(`origin/dat-dev:${TARGET}`);
    expect(shows.some((ref) => ref?.includes(".env") || ref?.includes("passwd"))).toBe(false);
  });

  it("live mode commits, pushes only the ai/ branch and opens a PR into dat-dev with the label", async () => {
    const result = await cycle(new FakeLlm([DIAGNOSIS, PATCH]), new FakeToolchain(), { dryRun: false }).run();
    expect(result.detail).toBe("opened PR https://github.com/tcuong2003/bot_trade_feature_binance/pull/42");
    expect(result.decision).toBe("pr-opened");
    const push = runner.pushed();
    expect(push).toHaveLength(1);
    expect(push[0]?.args).toEqual(["push", "origin", `${result.branch}:refs/heads/${result.branch}`]);
    const create = runner.prCreates()[0]!;
    expect(create.args).toEqual(expect.arrayContaining(["--base", "dat-dev", "--head", result.branch!, "--label", "ai-generated"]));
    expect(runner.calls.some((call) => call.command === "gh" && call.args[0] === "label" && call.args[1] === "create")).toBe(true);
    const memory = loadMemory(join(config.stateDir, MEMORY_FILE));
    expect(memory.hypotheses.at(-1)).toMatchObject({ status: "pr-open", prNumber: 42 });
  });

  it("gate: with an open ai-generated PR it only writes a report (no patch step, no worktree)", async () => {
    runner.openPrs = [{ number: 7, url: "u", headRefName: "ai/20261001-0000-x" }];
    const llm = new FakeLlm([DIAGNOSIS]);
    const result = await cycle(llm, new FakeToolchain(), { dryRun: false }).run();
    expect(result.decision).toBe("blocked-open-pr");
    expect(llm.prompts).toHaveLength(1);
    expect(runner.calls.some((call) => call.args[0] === "worktree")).toBe(false);
    expect(runner.pushed()).toEqual([]);
    expect(existsSync(result.reportPath!)).toBe(true);
  });

  it("gate fails closed in live mode when gh is unavailable", async () => {
    runner.ghFails = true;
    const gate = await checkOpenPrGate(runner, dir, 1, false);
    expect(gate.allowed).toBe(false);
    expect((await checkOpenPrGate(runner, dir, 1, true)).allowed).toBe(true);
    expect((await checkOpenPrGate(new FakeRunner(), dir, 0, true)).allowed).toBe(false);
  });

  it("rejects a forbidden diff without creating a worktree or asking for a fix", async () => {
    const bad = JSON.stringify({ title: "chore: tweak", body: "", diff: GOOD_DIFF.replaceAll(TARGET, "apps/api/src/application/runtime/ExecutionPolicy.ts") });
    const llm = new FakeLlm([DIAGNOSIS, bad]);
    const result = await cycle(llm).run();
    expect(result.decision).toBe("invalid-diff");
    expect(llm.prompts).toHaveLength(2);
    expect(runner.calls.some((call) => call.args[0] === "worktree")).toBe(false);
    expect(loadMemory(join(config.stateDir, MEMORY_FILE)).hypotheses.at(-1)?.status).toBe("invalid");
  });

  it("retries with the LLM on failing tests and abandons after MAX_FIX_ATTEMPTS", async () => {
    const llm = new FakeLlm([DIAGNOSIS, PATCH, PATCH, PATCH]);
    const toolchain = new FakeToolchain([{ typecheck: true, test: false }]);
    const result = await cycle(llm, toolchain).run();
    expect(result.decision).toBe("abandoned");
    expect(llm.prompts).toHaveLength(4); // diagnose + patch + 2 fixes
    expect(llm.prompts[2]?.[1]?.content).toContain("FAIL engine.test.ts");
    expect(toolchain.installs).toBe(1);
    expect(runner.calls.filter((call) => call.args[0] === "branch" && call.args[1] === "-D")).toHaveLength(1);
    expect(loadMemory(join(config.stateDir, MEMORY_FILE)).hypotheses.at(-1)?.status).toBe("abandoned");
  });

  it("succeeds on a fix attempt", async () => {
    const llm = new FakeLlm([DIAGNOSIS, PATCH, PATCH]);
    const result = await cycle(llm, new FakeToolchain([{ typecheck: false, test: true }, { typecheck: true, test: true }])).run();
    expect(result.decision).toBe("dry-run");
    expect(llm.prompts[2]?.[1]?.content).toContain("typecheck failed");
  });

  it("aborts when git applied changes outside the validated paths", async () => {
    runner.statusPaths = [TARGET, TEST_FILE, "package.json"];
    const result = await cycle(new FakeLlm([DIAGNOSIS, PATCH])).run();
    expect(result.decision).toBe("abandoned");
    expect(result.detail).toContain("post-apply verification failed");
  });

  it("writes a report when no code change is warranted and advances the cursor", async () => {
    const llm = new FakeLlm([JSON.stringify({ summary: "fine", severity: "none", codeChangeWarranted: false })]);
    const result = await cycle(llm).run();
    expect(result.decision).toBe("no-change");
    expect(readdirSync(config.reportsDir)).toHaveLength(1);
    // second run: nothing new -> skipped, no LLM call
    const again = await cycle(new FakeLlm([])).run();
    expect(again.decision).toBe("skipped");
  });

  it("skips (cursor kept) when there is not enough new signal", async () => {
    const result = await cycle(new FakeLlm([]), new FakeToolchain(), { minNewLines: 10_000 }).run();
    expect(result.decision).toBe("skipped");
    expect(runner.calls).toEqual([]);
    const forced = await cycle(new FakeLlm([JSON.stringify({ summary: "x", codeChangeWarranted: false })]), new FakeToolchain(), { minNewLines: 10_000 }).run({ force: true });
    expect(forced.decision).toBe("no-change");
  });

  it("keeps the cursor on LLM transport errors so the window is retried", async () => {
    const failing: LlmClient = { complete: async () => Promise.reject(new Error("fetch failed")) };
    expect((await cycle(failing).run()).decision).toBe("error");
    const llm = new FakeLlm([JSON.stringify({ summary: "x", codeChangeWarranted: false })]);
    expect((await cycle(llm).run()).decision).toBe("no-change");
  });

  it("digest-only never touches git, gh, the LLM or the cursor", async () => {
    const result = await cycle(new FakeLlm([])).run({ digestOnly: true });
    expect(result.digestText).toContain("PRICE_BEYOND_PROTECTION");
    expect(runner.calls).toEqual([]);
    expect(existsSync(join(config.stateDir, "cursors.json"))).toBe(false);
  });
});

describe("memory", () => {
  it("refreshes PR outcomes and review feedback via gh pr view", async () => {
    const runner = new FakeRunner();
    runner.prView[5] = { state: "CLOSED", reviews: [{ state: "CHANGES_REQUESTED", body: "This weakens the RR gate", author: { login: "dat" } }], comments: [] };
    runner.prView[6] = { state: "MERGED", mergedAt: "2026-10-04T00:00:00Z", reviews: [], comments: [{ body: "nice", author: { login: "c" } }] };
    const memory = emptyMemory();
    memory.hypotheses.push(
      { id: "a", at: "x", title: "Lower min RR", proposal: "", files: [], status: "pr-open", prNumber: 5 },
      { id: "b", at: "x", title: "Fix archive reason", proposal: "", files: [], status: "pr-open", prNumber: 6 }
    );
    await refreshPrOutcomes(memory, runner, ".");
    expect(memory.hypotheses.map((h) => h.status)).toEqual(["closed", "merged"]);
    const text = memoryForPrompt(memory, 5_000);
    expect(text).toContain("Rejected / failed ideas");
    expect(text).toContain("This weakens the RR gate");
    expect(text).toContain("Accepted (merged)");
    expect(memoryForPrompt(memory, 100).length).toBeLessThanOrEqual(100);
  });

  it("round-trips and caps history", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-agent-mem-"));
    const file = join(dir, "memory.json");
    const memory = emptyMemory();
    for (let i = 0; i < 250; i += 1) memory.runs.push({ id: String(i), at: "x", window: { from: null, to: null }, lines: 1, digestSummary: "", severity: "none", findings: [], decision: "skipped" });
    saveMemory(file, memory);
    expect(loadMemory(file).runs).toHaveLength(200);
    rmSync(dir, { recursive: true, force: true });
  });
});
