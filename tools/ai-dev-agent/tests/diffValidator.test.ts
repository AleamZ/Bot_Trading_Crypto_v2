import { describe, expect, it } from "vitest";
import { checkPath, parseUnifiedDiff, validateDiff } from "../src/diffValidator.js";

const limits = { maxFiles: 8, maxChangedLines: 400 };

function modify(path: string, added: string[] = ["const b = 2;"], removed: string[] = ["const a = 1;"]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length + 1} +1,${added.length + 1} @@`,
    " // context",
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ""
  ].join("\n");
}

function newFile(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    ""
  ].join("\n");
}

describe("diff parsing", () => {
  it("parses git diffs with new files and counts lines", () => {
    const diff = modify("apps/api/src/application/engine/TradingEngine.ts") + newFile("apps/api/tests/new.test.ts", ["a", "b", "c"]);
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ oldPath: "apps/api/src/application/engine/TradingEngine.ts", added: ["const b = 2;"], removed: ["const a = 1;"] });
    expect(files[1]).toMatchObject({ oldPath: null, newPath: "apps/api/tests/new.test.ts", isNew: true, added: ["a", "b", "c"] });
  });

  it("parses plain ---/+++ diffs (no diff --git header) and CRLF", () => {
    const diff = "--- a/docs/x.md\r\n+++ b/docs/x.md\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n";
    const result = validateDiff(diff, limits);
    expect(result.ok).toBe(true);
    expect(result.paths).toEqual(["docs/x.md"]);
    expect(result.changedLines).toBe(2);
  });

  it("does not mistake removed lines starting with '--' for headers", () => {
    const diff = ["--- a/docs/x.md", "+++ b/docs/x.md", "@@ -1,2 +1,1 @@", "--- not a header", " keep", ""].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]?.removed).toEqual(["-- not a header"]);
  });
});

describe("validateDiff: allowed paths", () => {
  it.each([
    "apps/api/src/application/engine/TradingEngine.ts",
    "apps/api/tests/engine.test.ts",
    "apps/web/app.js",
    "docs/ai/notes.md",
    "trading_rules.md"
  ])("accepts %s", (path) => {
    const result = validateDiff(modify(path), limits);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["README.md", "outside the allowed"],
    ["apps/api/package.json", "package*.json"],
    ["package.json", "package*.json"],
    ["package-lock.json", "package*.json"],
    ["apps/web/package.json", "package*.json"],
    [".env", ".env"],
    ["apps/api/.env.production", ".env"],
    ["apps/web/.env.local", ".env"],
    ["ecosystem.config.cjs", "ecosystem"],
    ["deploy-api.sh", "deploy"],
    ["tools/ai-dev-agent/src/cycle.ts", "self-modification"],
    ["apps/api/src/infrastructure/execution/LockedRealExecutionGateway.ts", "lock gateway"],
    ["apps/api/src/application/execution/RealExecutionProposal.ts", "proposal"],
    ["apps/api/src/application/execution/RealExecutionProposalGateway.ts", "proposal"],
    ["apps/api/src/application/execution/RealExecutionProposalRepository.ts", "proposal"],
    ["apps/api/src/application/runtime/ExecutionPolicy.ts", "execution policy"],
    ["apps/api/tsconfig.json", "outside the allowed"],
    ["packages/shared/index.ts", "outside the allowed"],
    [".github/workflows/ci.yml", "CI configuration"],
    ["apps/web/.github/x.yml", "CI configuration"]
  ])("rejects %s", (path, reason) => {
    const result = validateDiff(modify(path), limits);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(reason);
  });

  it.each(["apps/api/src/../../.env", "/etc/passwd", "C:/x/apps/api/src/a.ts", "apps\\api\\src\\a.ts", "apps/api/src//a.ts"])("rejects unsafe path %s", (path) => {
    expect(checkPath(path)).not.toBeNull();
  });

  it("rejects new forbidden files and deletions of forbidden files", () => {
    expect(validateDiff(newFile("apps/api/.env", ["SECRET=1"]), limits).ok).toBe(false);
    const deletion = ["diff --git a/ecosystem.config.cjs b/ecosystem.config.cjs", "deleted file mode 100644", "--- a/ecosystem.config.cjs", "+++ /dev/null", "@@ -1 +0,0 @@", "-x", ""].join("\n");
    expect(validateDiff(deletion, limits).ok).toBe(false);
  });

  it("rejects renames, mode changes, symlinks and binary patches", () => {
    const rename = ["diff --git a/docs/a.md b/docs/b.md", "similarity index 90%", "rename from docs/a.md", "rename to docs/b.md", "--- a/docs/a.md", "+++ b/docs/b.md", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    expect(validateDiff(rename, limits).ok).toBe(false);
    const mode = ["diff --git a/docs/a.md b/docs/a.md", "old mode 100644", "new mode 100755", "--- a/docs/a.md", "+++ b/docs/a.md", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    expect(validateDiff(mode, limits).errors.join()).toContain("old mode");
    const symlink = ["diff --git a/docs/l b/docs/l", "new file mode 120000", "--- /dev/null", "+++ b/docs/l", "@@ -0,0 +1 @@", "+../.env", ""].join("\n");
    expect(validateDiff(symlink, limits).ok).toBe(false);
    const binary = ["diff --git a/docs/x.png b/docs/x.png", "new file mode 100644", "GIT binary patch", "literal 1", ""].join("\n");
    expect(validateDiff(binary, limits).ok).toBe(false);
  });
});

describe("validateDiff: forbidden content", () => {
  it.each([
    ["realLiveExecutionEnabled: true,", "realLiveExecutionEnabled"],
    ["process.env.REAL_LIVE_EXECUTION_ENABLED = 'true';", "REAL_LIVE_EXECUTION_ENABLED"],
    ['if (reason === "REAL_EXECUTION_LOCKED") return;', "REAL_EXECUTION_LOCKED"],
    ['realExecutionMode: "DRY_RUN",', "realExecutionMode"],
    ["import { LockedRealExecutionGateway } from './x.js';", "LockedRealExecutionGateway"],
    ["const p = new RealExecutionProposalGateway();", "RealExecutionProposal"],
    ["const policy = resolveExecutionPolicy(config);", "ExecutionPolicy"],
    ["const baseUrl = useMainnet ? MAINNET : TESTNET; // testnet", "testnet/mainnet"],
    ["import { execSync } from 'node:child_process';", "process spawning"],
    ['const apiSecret = "abcdefghijklmnop1234";', "hard-coded credential"]
  ])("rejects an added line containing %s", (line, reason) => {
    const result = validateDiff(modify("apps/api/src/application/engine/TradingEngine.ts", [line], ["const a = 1;"]), limits);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(reason);
  });

  it("also rejects removing a lock check (removed lines are scanned)", () => {
    const result = validateDiff(modify("apps/api/src/application/execution/ExecutionCoordinator.ts", ["// gone"], ['throw new Error("REAL_EXECUTION_LOCKED");']), limits);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("removed line");
  });

  it("ignores forbidden tokens on context lines", () => {
    const diff = [
      "--- a/apps/api/src/a.ts",
      "+++ b/apps/api/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " if (config.realLiveExecutionEnabled) {",
      "-  const a = 1;",
      "+  const a = 2;",
      ""
    ].join("\n");
    expect(validateDiff(diff, limits).ok).toBe(true);
  });
});

describe("validateDiff: limits", () => {
  it("enforces MAX_FILES", () => {
    const diff = [1, 2, 3].map((n) => modify(`docs/f${n}.md`)).join("");
    expect(validateDiff(diff, { maxFiles: 3, maxChangedLines: 400 }).ok).toBe(true);
    const result = validateDiff(diff, { maxFiles: 2, maxChangedLines: 400 });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("MAX_FILES=2");
  });

  it("enforces MAX_CHANGED_LINES", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const diff = newFile("docs/big.md", lines);
    expect(validateDiff(diff, { maxFiles: 8, maxChangedLines: 30 }).ok).toBe(true);
    const result = validateDiff(diff, { maxFiles: 8, maxChangedLines: 29 });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("MAX_CHANGED_LINES=29");
  });

  it("rejects empty diffs and diffs without file sections", () => {
    expect(validateDiff("", limits).ok).toBe(false);
    expect(validateDiff("just some prose\n", limits).ok).toBe(false);
  });
});
