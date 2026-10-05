import { describe, expect, it } from "vitest";
import { CommandSafetyError, SafeCommandRunner, assertSafeCommand, type CommandRunner } from "../src/commandRunner.js";
import { buildConfig, parseDryRun } from "../src/config.js";
import { branchName, parsePorcelainZ, slugify } from "../src/git.js";

const NODE = "/usr/bin/node";
const ok = (command: string, args: string[]) => () => assertSafeCommand(command, args, NODE);

describe("assertSafeCommand", () => {
  it("allows the commands the pipeline needs", () => {
    expect(ok("git", ["fetch", "origin", "--prune"])).not.toThrow();
    expect(ok("git", ["worktree", "add", "-b", "ai/20261005-1030-fix-x", "/tmp/wt", "origin/dat-dev"])).not.toThrow();
    expect(ok("git", ["worktree", "remove", "--force", "/tmp/wt"])).not.toThrow();
    expect(ok("git", ["push", "origin", "ai/20261005-1030-fix-x:refs/heads/ai/20261005-1030-fix-x"])).not.toThrow();
    expect(ok("git", ["branch", "-D", "ai/20261005-1030-fix-x"])).not.toThrow();
    expect(ok("gh", ["pr", "create", "--base", "dat-dev", "--head", "ai/20261005-1030-fix-x", "--title", "t", "--body-file", "b", "--label", "ai-generated"])).not.toThrow();
    expect(ok("gh", ["pr", "list", "--state", "open"])).not.toThrow();
    expect(ok(NODE, ["vitest.mjs", "run"])).not.toThrow();
  });

  it.each([
    ["git", ["push", "origin", "dat-dev"]],
    ["git", ["push", "origin", "main:refs/heads/main"]],
    ["git", ["push", "origin", "ai/20261005-1030-fix-x:refs/heads/dat-dev"]],
    ["git", ["push", "origin", "+ai/20261005-1030-fix-x:refs/heads/ai/20261005-1030-fix-x"]],
    ["git", ["push", "--force", "origin", "ai/20261005-1030-fix-x:refs/heads/ai/20261005-1030-fix-x"]],
    ["git", ["push", "origin", "--delete", "ai/x"]],
    ["git", ["-c", "x=y", "push", "origin", "dat-dev"]],
    ["git", ["merge", "ai/20261005-1030-fix-x"]],
    ["git", ["branch", "-D", "dat-dev"]],
    ["git", ["checkout", "main"]],
    ["gh", ["pr", "merge", "12"]],
    ["gh", ["pr", "create", "--base", "dat-dev", "--head", "dat-dev"]],
    ["gh", ["api", "repos/x/y/merges"]],
    ["bash", ["-c", "rm -rf /"]],
    ["npm", ["publish"]]
  ] as Array<[string, string[]]>)("refuses %s %j", (command, args) => {
    expect(ok(command, args)).toThrow(CommandSafetyError);
  });

  it("SafeCommandRunner never reaches the inner runner for refused commands", async () => {
    const seen: string[] = [];
    const inner: CommandRunner = { run: async (command, args) => (seen.push(`${command} ${args.join(" ")}`), { code: 0, stdout: "", stderr: "" }) };
    const runner = new SafeCommandRunner(inner, NODE);
    await expect(runner.run("git", ["push", "origin", "main"], { cwd: "." })).rejects.toThrow(CommandSafetyError);
    await runner.run("git", ["status"], { cwd: "." });
    expect(seen).toEqual(["git status"]);
  });
});

describe("config & helpers", () => {
  it("dry-run is ON unless explicitly 'false'", () => {
    expect(parseDryRun(undefined)).toBe(true);
    expect(parseDryRun("")).toBe(true);
    expect(parseDryRun("0")).toBe(true);
    expect(parseDryRun("no")).toBe(true);
    expect(parseDryRun("FALSE")).toBe(false);
    expect(buildConfig({}, "/repo/tools/ai-dev-agent").dryRun).toBe(true);
  });

  it("builds defaults relative to the repo", () => {
    const config = buildConfig({ INTERVAL_MINUTES: "15", MAX_OPEN_AI_PRS: "2" }, "/repo/tools/ai-dev-agent");
    expect(config.baseBranch).toBe("dat-dev");
    expect(config.ai.baseUrl).toBe("http://localhost:20128/v1");
    expect(config.intervalMinutes).toBe(15);
    expect(config.maxOpenAiPrs).toBe(2);
    expect(config.maxFixAttempts).toBe(2);
    expect(config.logPaths.map((p) => p.replace(/\\/g, "/"))).toEqual([
      expect.stringMatching(/\/repo\/logs\/smc-futures-api\/out\.log$/),
      expect.stringMatching(/\/repo\/logs\/smc-futures-api\/error\.log$/)
    ]);
    expect(() => buildConfig({ BASE_BRANCH: "--upload-pack=x" }, "/repo/tools/ai-dev-agent")).toThrow();
  });

  it("generates safe ai/ branch names", () => {
    const name = branchName("fix(engine): Handle PRICE_BEYOND_PROTECTION; `rm -rf` $(x)", new Date(2026, 9, 5, 9, 7));
    expect(name).toMatch(/^ai\/20261005-0907-handle-price-beyond-protection-rm-rf-x$/);
    expect(slugify("!!!")).toBe("improvement");
  });

  it("parses porcelain -z output including renames", () => {
    expect(parsePorcelainZ(" M apps/api/src/a.ts\0?? docs/new.md\0R  docs/b.md\0docs/a.md\0")).toEqual(["apps/api/src/a.ts", "docs/new.md", "docs/b.md", "docs/a.md"]);
  });
});
