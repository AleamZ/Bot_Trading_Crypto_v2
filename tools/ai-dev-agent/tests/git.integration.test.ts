import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecFileRunner, SafeCommandRunner } from "../src/commandRunner.js";
import { validateDiff } from "../src/diffValidator.js";
import { GitOps } from "../src/git.js";

/**
 * Exercises GitOps against a throw-away repository + bare "origin" in the OS temp dir
 * (never the real project repository).
 */
describe("GitOps against a real temporary git repository", () => {
  const raw = new ExecFileRunner();
  let root: string;
  let repo: string;
  let worktrees: string;
  let git: GitOps;
  const branch = "ai/20261005-1030-integration";
  const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

  const sh = async (cwd: string, ...args: string[]) => {
    const result = await raw.run("git", args, { cwd, env });
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "ai-agent-git-"));
    repo = join(root, "repo");
    worktrees = join(root, "worktrees");
    mkdirSync(join(repo, "apps", "api", "src"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    await sh(root, "init", "--bare", "-b", "dat-dev", "origin.git");
    await sh(repo, "init", "-b", "dat-dev");
    await sh(repo, "config", "core.autocrlf", "false");
    writeFileSync(join(repo, "apps", "api", "src", "a.ts"), "export const x = 1;\nexport const y = 2;\n");
    writeFileSync(join(repo, "docs", "x.md"), "hello\n");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    await sh(repo, "add", ".");
    await sh(repo, "commit", "-q", "-m", "init");
    await sh(repo, "remote", "add", "origin", join(root, "origin.git"));
    await sh(repo, "push", "-q", "origin", "dat-dev");
    git = new GitOps(new SafeCommandRunner(raw), repo, "origin", worktrees);
  }, 60_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("creates a worktree, applies/validates a patch, resets, commits, pushes the ai branch and cleans up", async () => {
    expect((await git.fetch()).code).toBe(0);
    expect(await git.refExists("origin/dat-dev")).toBe(true);
    expect(await git.refExists("origin/nope")).toBe(false);
    const wt = join(worktrees, "ai_20261005-1030-integration");
    await git.addWorktree(wt, branch, "origin/dat-dev");
    expect(await git.currentBranch(wt)).toBe(branch);

    const diff = [
      "diff --git a/apps/api/src/a.ts b/apps/api/src/a.ts",
      "--- a/apps/api/src/a.ts",
      "+++ b/apps/api/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " export const x = 1;",
      "-export const y = 2;",
      "+export const y = 3;",
      "diff --git a/docs/new.md b/docs/new.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/new.md",
      "@@ -0,0 +1 @@",
      "+new doc",
      ""
    ].join("\n");
    const patchFile = join(root, "p.diff");
    writeFileSync(patchFile, diff);
    const bad = join(root, "bad.diff");
    writeFileSync(bad, diff.replace("-export const y = 2;", "-export const y = 999;"));
    expect((await git.applyCheck(wt, bad)).code).not.toBe(0);

    expect((await git.applyCheck(wt, patchFile)).code).toBe(0);
    expect((await git.apply(wt, patchFile)).code).toBe(0);
    await git.stage(wt, ["apps/api/src/a.ts", "docs/new.md"]);
    expect((await git.status(wt)).sort()).toEqual(["apps/api/src/a.ts", "docs/new.md"]);
    const staged = validateDiff(await git.stagedDiff(wt), { maxFiles: 8, maxChangedLines: 100 });
    expect(staged.errors).toEqual([]);
    expect(staged.paths).toEqual(["apps/api/src/a.ts", "docs/new.md"]);

    await git.resetHard(wt);
    expect(await git.status(wt)).toEqual([]);

    await git.apply(wt, patchFile);
    await git.stage(wt, ["apps/api/src/a.ts", "docs/new.md"]);
    const message = join(root, "msg.txt");
    writeFileSync(message, "docs: integration\n");
    await git.commit(wt, message);
    expect((await git.changedSinceBase(wt, "origin/dat-dev")).sort()).toEqual(["apps/api/src/a.ts", "docs/new.md"]);
    const author = await sh(wt, "log", "-1", "--format=%an <%ae>");
    expect(author.trim()).toBe("AI Dev Agent <ai-dev-agent@local>");

    await git.pushBranch(wt, branch);
    const remoteBranches = await sh(repo, "ls-remote", "--heads", "origin");
    expect(remoteBranches).toContain(`refs/heads/${branch}`);
    // dat-dev on origin is untouched
    expect(await sh(repo, "rev-parse", "origin/dat-dev")).toBe(await sh(repo, "rev-parse", "dat-dev"));

    await git.removeWorktree(wt, branch);
    expect(await git.refExists(`refs/heads/${branch}`)).toBe(false);
    await expect(git.addWorktree(join(root, "elsewhere"), branch, "origin/dat-dev")).rejects.toThrow(/outside the agent worktree root/);
  }, 120_000);
});
