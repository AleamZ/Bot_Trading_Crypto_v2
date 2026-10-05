import { existsSync, lstatSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CommandRunner } from "./commandRunner.js";

export interface StepResult {
  ok: boolean;
  output: string;
  durationMs: number;
}

/** Installs dependencies and runs the api checks inside a worktree. */
export interface Toolchain {
  install(worktree: string): Promise<StepResult>;
  typecheck(worktree: string): Promise<StepResult>;
  test(worktree: string): Promise<StepResult>;
  /** Must be called before the worktree is removed (detaches a node_modules link safely). */
  cleanup(worktree: string): void;
}

export function tail(text: string, max = 4_000): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/** Locates npm-cli.js so npm can be run through the node binary (no shell, works on Windows). */
export function resolveNpmCli(): string | null {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  for (const candidate of candidates) {
    if (candidate && /npm-cli\.js$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Real toolchain.
 * - `link` (default): junction/symlink `<worktree>/node_modules` -> `<repo>/node_modules`. Reliable because the
 *   validator forbids any change to package*.json, so the dependency set of the worktree is identical to the repo's,
 *   and apps/api does not import other workspace packages.
 * - `ci`: `npm ci` inside the worktree (slower, fully isolated).
 */
export class NodeToolchain implements Toolchain {
  constructor(
    private readonly runner: CommandRunner,
    private readonly repoPath: string,
    private readonly mode: "link" | "ci",
    private readonly timeoutMs: number
  ) {}

  private async node(args: string[], cwd: string): Promise<StepResult> {
    const started = Date.now();
    const result = await this.runner.run(process.execPath, args, { cwd, timeoutMs: this.timeoutMs, env: { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" } });
    return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim(), durationMs: Date.now() - started };
  }

  async install(worktree: string): Promise<StepResult> {
    const started = Date.now();
    const repoModules = join(this.repoPath, "node_modules");
    const target = join(worktree, "node_modules");
    if (this.mode === "link" && existsSync(repoModules)) {
      try {
        symlinkSync(repoModules, target, process.platform === "win32" ? "junction" : "dir");
        return { ok: true, output: `linked ${target} -> ${repoModules}`, durationMs: Date.now() - started };
      } catch (error) {
        // fall through to npm ci
        const message = error instanceof Error ? error.message : String(error);
        const ci = await this.npmCi(worktree);
        return { ...ci, output: `link failed (${message}); npm ci:\n${ci.output}` };
      }
    }
    return this.npmCi(worktree);
  }

  private async npmCi(worktree: string): Promise<StepResult> {
    const npmCli = resolveNpmCli();
    if (!npmCli) return { ok: false, output: "npm-cli.js not found; cannot run npm ci", durationMs: 0 };
    return this.node([npmCli, "ci", "--no-audit", "--no-fund"], worktree);
  }

  typecheck(worktree: string): Promise<StepResult> {
    const tsc = join(worktree, "node_modules", "typescript", "bin", "tsc");
    return this.node([tsc, "-p", "tsconfig.json", "--noEmit"], join(worktree, "apps", "api"));
  }

  test(worktree: string): Promise<StepResult> {
    const vitest = join(worktree, "node_modules", "vitest", "vitest.mjs");
    return this.node([vitest, "run"], join(worktree, "apps", "api"));
  }

  cleanup(worktree: string): void {
    const target = join(worktree, "node_modules");
    try {
      const stat = lstatSync(target);
      if (!stat.isSymbolicLink()) return; // a real npm ci install is removed with the worktree
      try {
        unlinkSync(target);
      } catch {
        rmdirSync(target); // Windows junctions
      }
    } catch {
      // nothing to clean
    }
  }
}
