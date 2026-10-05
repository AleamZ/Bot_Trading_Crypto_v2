import { resolve, sep } from "node:path";
import { AI_BRANCH_PATTERN, type CommandResult, type CommandRunner } from "./commandRunner.js";

export const AGENT_AUTHOR = { name: "AI Dev Agent", email: "ai-dev-agent@local" };

export class GitError extends Error {
  constructor(message: string, readonly result: CommandResult) {
    super(`${message}: ${(result.stderr || result.stdout).trim().slice(0, 1_000)}`);
  }
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "improvement";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function branchName(title: string, now: Date): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const name = `ai/${stamp}-${slugify(title)}`;
  if (!AI_BRANCH_PATTERN.test(name)) throw new Error(`Generated branch name is invalid: ${name}`);
  return name;
}

/** Parses `git status --porcelain=v1 -z` output into repo-relative paths. */
export function parsePorcelainZ(output: string): string[] {
  const parts = output.split("\0").filter((part) => part.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i] ?? "";
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.startsWith("R") || status.startsWith("C")) {
      // rename/copy: next NUL-separated field is the source path
      i += 1;
      if (parts[i]) paths.push(parts[i] as string);
    }
  }
  return paths;
}

export class GitOps {
  constructor(
    private readonly runner: CommandRunner,
    private readonly repoPath: string,
    private readonly remote: string,
    private readonly worktreeRoot: string
  ) {}

  private async git(args: string[], cwd = this.repoPath, timeoutMs = 120_000): Promise<CommandResult> {
    return this.runner.run("git", args, { cwd, timeoutMs });
  }

  private assertAgentWorktree(path: string): void {
    const root = resolve(this.worktreeRoot) + sep;
    if (!resolve(path).startsWith(root)) throw new Error(`Refusing to operate outside the agent worktree root: ${path}`);
  }

  async fetch(): Promise<CommandResult> {
    return this.git(["fetch", this.remote], this.repoPath, 300_000);
  }

  async showFile(ref: string, path: string): Promise<string | null> {
    const result = await this.git(["show", `${ref}:${path}`]);
    return result.code === 0 ? result.stdout : null;
  }

  async refExists(ref: string): Promise<boolean> {
    const result = await this.git(["rev-parse", "--verify", "--quiet", ref]);
    return result.code === 0;
  }

  async addWorktree(path: string, branch: string, startRef: string): Promise<void> {
    this.assertAgentWorktree(path);
    if (!AI_BRANCH_PATTERN.test(branch)) throw new Error(`Refusing non-ai branch ${branch}`);
    const result = await this.git(["worktree", "add", "-b", branch, path, startRef]);
    if (result.code !== 0) throw new GitError("git worktree add failed", result);
  }

  async removeWorktree(path: string, branch: string): Promise<void> {
    this.assertAgentWorktree(path);
    await this.git(["worktree", "remove", "--force", path]);
    await this.git(["worktree", "prune"]);
    if (AI_BRANCH_PATTERN.test(branch)) await this.git(["branch", "-D", branch]);
  }

  async applyCheck(worktree: string, patchFile: string): Promise<CommandResult> {
    this.assertAgentWorktree(worktree);
    return this.git(["apply", "--check", "--whitespace=nowarn", patchFile], worktree);
  }

  async apply(worktree: string, patchFile: string): Promise<CommandResult> {
    this.assertAgentWorktree(worktree);
    return this.git(["apply", "--whitespace=nowarn", patchFile], worktree);
  }

  async stage(worktree: string, paths: string[]): Promise<CommandResult> {
    this.assertAgentWorktree(worktree);
    return this.git(["add", "--", ...paths], worktree);
  }

  async status(worktree: string): Promise<string[]> {
    this.assertAgentWorktree(worktree);
    const result = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], worktree);
    if (result.code !== 0) throw new GitError("git status failed", result);
    return parsePorcelainZ(result.stdout);
  }

  async stagedDiff(worktree: string): Promise<string> {
    this.assertAgentWorktree(worktree);
    const result = await this.git(["diff", "--cached", "--no-color", "--no-ext-diff", "--no-renames"], worktree);
    if (result.code !== 0) throw new GitError("git diff --cached failed", result);
    return result.stdout;
  }

  /** Restores the worktree to its branch HEAD (only inside the agent worktree root). */
  async resetHard(worktree: string): Promise<void> {
    this.assertAgentWorktree(worktree);
    await this.git(["reset", "-q", "--hard", "HEAD"], worktree);
  }

  async commit(worktree: string, messageFile: string): Promise<void> {
    this.assertAgentWorktree(worktree);
    const result = await this.runner.run("git", ["commit", "-q", "-F", messageFile], {
      cwd: worktree,
      timeoutMs: 120_000,
      env: {
        GIT_AUTHOR_NAME: AGENT_AUTHOR.name,
        GIT_AUTHOR_EMAIL: AGENT_AUTHOR.email,
        GIT_COMMITTER_NAME: AGENT_AUTHOR.name,
        GIT_COMMITTER_EMAIL: AGENT_AUTHOR.email
      }
    });
    if (result.code !== 0) throw new GitError("git commit failed", result);
  }

  async currentBranch(worktree: string): Promise<string> {
    const result = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], worktree);
    return result.stdout.trim();
  }

  async changedSinceBase(worktree: string, baseRef: string): Promise<string[]> {
    const result = await this.git(["diff", "--name-only", "--no-renames", `${baseRef}...HEAD`], worktree);
    if (result.code !== 0) throw new GitError("git diff --name-only failed", result);
    return result.stdout.split(/\r?\n/).filter(Boolean);
  }

  /** Pushes ONLY the given ai/... branch to the same-named remote ref. Never forced. */
  async pushBranch(worktree: string, branch: string): Promise<void> {
    if (!AI_BRANCH_PATTERN.test(branch)) throw new Error(`Refusing to push non-ai branch ${branch}`);
    const result = await this.git(["push", this.remote, `${branch}:refs/heads/${branch}`], worktree, 300_000);
    if (result.code !== 0) throw new GitError("git push failed", result);
  }
}
