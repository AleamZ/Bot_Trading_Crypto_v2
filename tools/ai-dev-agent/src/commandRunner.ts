import { execFile } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

/**
 * All external processes go through this interface. Commands are always an
 * executable plus an argument array: there is never a shell, so LLM text can
 * never be interpreted as a shell command.
 */
export interface CommandRunner {
  run(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult>;
}

export class CommandSafetyError extends Error {}

/** Branch names the agent is allowed to create, push and delete. */
export const AI_BRANCH_PATTERN = /^ai\/\d{8}-\d{4}-[a-z0-9][a-z0-9-]{0,59}$/;

const PROTECTED_BRANCHES = new Set(["main", "master", "dat-dev"]);

/**
 * Hard guard applied to every command, independent of the pipeline logic:
 *  - only `git`, `gh` and the current node binary may be executed;
 *  - `git push` only as `push <remote> ai/x:refs/heads/ai/x`, never forced, never deleting;
 *  - no `gh pr merge`, no `gh api`, no `gh repo` mutations;
 *  - `git branch -D/-d`, `git worktree remove` only on ai/... branches / agent worktrees.
 */
export function assertSafeCommand(command: string, rawArgs: readonly string[], nodeBinary: string = process.execPath): void {
  if (command === nodeBinary) return;
  if (command === "git") {
    // Global options (`-c k=v`, `-C dir`, `--no-pager`...) are not used by the agent; refuse them so the
    // sub-command is always args[0] and cannot be smuggled past the checks below.
    if ((rawArgs[0] ?? "").startsWith("-")) throw new CommandSafetyError(`git global options are not permitted: git ${rawArgs.join(" ")}`);
    const args = rawArgs;
    // Case-sensitive on purpose: `-F <file>` (commit message file) is not `-f` (force).
    if (args.some((arg) => arg === "--force" || arg === "-f" || arg.startsWith("--force-") || arg === "--mirror")) {
      // "-f" is legitimate for `git worktree remove --force`; allow only there.
      if (!(args[0] === "worktree" && args[1] === "remove")) throw new CommandSafetyError(`Forced git operation refused: git ${args.join(" ")}`);
    }
    const sub = args[0];
    if (sub === "merge" || sub === "rebase" || sub === "filter-branch" || sub === "update-ref") {
      throw new CommandSafetyError(`git ${sub} is not permitted`);
    }
    if (sub === "push") {
      if (args.length !== 3) throw new CommandSafetyError(`Unexpected git push form: git ${args.join(" ")}`);
      const refspec = args[2] ?? "";
      const match = /^(ai\/[^:]+):refs\/heads\/(ai\/[^:]+)$/.exec(refspec);
      if (!match || match[1] !== match[2] || !AI_BRANCH_PATTERN.test(match[1] ?? "") || refspec.startsWith("+")) {
        throw new CommandSafetyError(`Push refused: only ai/... branches may be pushed (got ${refspec})`);
      }
      return;
    }
    if (sub === "branch" && (args.includes("-D") || args.includes("-d") || args.includes("--delete"))) {
      const target = args[args.length - 1] ?? "";
      if (!AI_BRANCH_PATTERN.test(target)) throw new CommandSafetyError(`Branch deletion refused for ${target}`);
    }
    if (sub === "checkout" || sub === "switch") {
      if (args.some((arg) => PROTECTED_BRANCHES.has(arg))) throw new CommandSafetyError(`Checkout of protected branch refused`);
    }
    return;
  }
  if (command === "gh") {
    const args = rawArgs;
    const [group, action] = args;
    if (group === "pr" && (action === "merge" || action === "close" || action === "ready" || action === "review")) {
      throw new CommandSafetyError(`gh pr ${action} is not permitted`);
    }
    if (group === "api" || group === "repo" || group === "release" || group === "secret" || group === "workflow") {
      throw new CommandSafetyError(`gh ${group} is not permitted`);
    }
    if (group === "pr" && action === "create") {
      const baseIndex = args.indexOf("--base");
      const headIndex = args.indexOf("--head");
      const head = headIndex >= 0 ? args[headIndex + 1] ?? "" : "";
      if (baseIndex < 0 || headIndex < 0 || !AI_BRANCH_PATTERN.test(head)) {
        throw new CommandSafetyError("gh pr create must specify --base and an ai/... --head");
      }
    }
    return;
  }
  throw new CommandSafetyError(`Executable not allowed: ${command}`);
}

/** Wraps any runner with {@link assertSafeCommand}. The production runner is always wrapped. */
export class SafeCommandRunner implements CommandRunner {
  constructor(
    private readonly inner: CommandRunner,
    private readonly nodeBinary: string = process.execPath
  ) {}

  async run(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    assertSafeCommand(command, args, this.nodeBinary);
    return this.inner.run(command, args, options);
  }
}

export class ExecFileRunner implements CommandRunner {
  run(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(
        command,
        [...args],
        {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? 120_000,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          shell: false,
          env: { ...process.env, ...(options.env ?? {}), GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }
        },
        (error, stdout, stderr) => {
          let code = 0;
          if (error) {
            const errno = (error as NodeJS.ErrnoException & { code?: unknown }).code;
            code = typeof errno === "number" ? errno : 1;
            if (code === 0) code = 1;
          }
          const extra = error && !stderr ? String(error.message) : "";
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") + extra });
        }
      );
    });
  }
}

export function createDefaultRunner(): CommandRunner {
  return new SafeCommandRunner(new ExecFileRunner());
}
