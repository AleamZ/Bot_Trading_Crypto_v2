import type { CommandRunner } from "./commandRunner.js";

export const AI_LABEL = "ai-generated";

export interface OpenPrInfo {
  number: number;
  url: string;
  headRefName: string;
}

export interface OpenPrGate {
  /** True when a new PR may be opened. */
  allowed: boolean;
  open: OpenPrInfo[];
  reason: string;
}

/**
 * At most `maxOpen` open `ai-generated` PRs. If `gh` cannot answer, the gate is
 * CLOSED in live mode (fail-safe) and open in dry-run mode (nothing is published anyway).
 */
export async function checkOpenPrGate(runner: CommandRunner, repoPath: string, maxOpen: number, dryRun: boolean): Promise<OpenPrGate> {
  if (maxOpen <= 0) return { allowed: false, open: [], reason: "MAX_OPEN_AI_PRS=0" };
  const result = await runner.run("gh", ["pr", "list", "--state", "open", "--label", AI_LABEL, "--json", "number,url,headRefName", "--limit", "50"], {
    cwd: repoPath,
    timeoutMs: 60_000
  });
  if (result.code !== 0) {
    const reason = `gh pr list failed: ${result.stderr.trim().slice(0, 300)}`;
    return { allowed: dryRun, open: [], reason: dryRun ? `${reason} (ignored in dry-run)` : reason };
  }
  let open: OpenPrInfo[] = [];
  try {
    const parsed: unknown = JSON.parse(result.stdout || "[]");
    if (Array.isArray(parsed)) open = parsed as OpenPrInfo[];
  } catch {
    return { allowed: dryRun, open: [], reason: "gh pr list returned invalid JSON" };
  }
  if (open.length >= maxOpen) {
    return { allowed: false, open, reason: `${open.length} open ${AI_LABEL} PR(s) (limit ${maxOpen}): ${open.map((pr) => `#${pr.number}`).join(", ")}` };
  }
  return { allowed: true, open, reason: `${open.length}/${maxOpen} open ${AI_LABEL} PRs` };
}

export async function ensureLabel(runner: CommandRunner, repoPath: string): Promise<void> {
  const list = await runner.run("gh", ["label", "list", "--json", "name", "--limit", "500"], { cwd: repoPath, timeoutMs: 60_000 });
  if (list.code === 0) {
    try {
      const names = (JSON.parse(list.stdout || "[]") as Array<{ name?: string }>).map((label) => label.name);
      if (names.includes(AI_LABEL)) return;
    } catch {
      // try to create anyway
    }
  }
  const created = await runner.run(
    "gh",
    ["label", "create", AI_LABEL, "--color", "5319E7", "--description", "Opened by the AI Dev Agent - requires human review"],
    { cwd: repoPath, timeoutMs: 60_000 }
  );
  if (created.code !== 0 && !/already exists/i.test(created.stderr)) {
    throw new Error(`gh label create failed: ${created.stderr.trim().slice(0, 300)}`);
  }
}

export async function createPullRequest(
  runner: CommandRunner,
  repoPath: string,
  args: { base: string; head: string; title: string; bodyFile: string }
): Promise<{ url: string; number: number | undefined }> {
  const result = await runner.run(
    "gh",
    ["pr", "create", "--base", args.base, "--head", args.head, "--title", args.title, "--body-file", args.bodyFile, "--label", AI_LABEL],
    { cwd: repoPath, timeoutMs: 120_000 }
  );
  if (result.code !== 0) throw new Error(`gh pr create failed: ${result.stderr.trim().slice(0, 500)}`);
  const url = result.stdout.trim().split(/\s+/).find((token) => /^https?:\/\//.test(token)) ?? result.stdout.trim();
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return { url, number: number ? Number(number) : undefined };
}
