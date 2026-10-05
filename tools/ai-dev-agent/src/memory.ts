import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandRunner } from "./commandRunner.js";

export type RunDecision = "skipped" | "no-change" | "report" | "blocked-open-pr" | "invalid-diff" | "abandoned" | "dry-run" | "pr-opened" | "error";

export interface RunRecord {
  id: string;
  at: string;
  window: { from: string | null; to: string | null };
  lines: number;
  digestSummary: string;
  severity: string;
  findings: string[];
  decision: RunDecision;
  detail?: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
}

export type HypothesisStatus = "dry-run" | "pr-open" | "merged" | "closed" | "abandoned" | "invalid";

export interface HypothesisRecord {
  id: string;
  at: string;
  title: string;
  proposal: string;
  files: string[];
  status: HypothesisStatus;
  reason?: string;
  prNumber?: number;
  prUrl?: string;
  feedback?: string[];
  checkedAt?: string;
}

export interface AgentMemory {
  version: 1;
  runs: RunRecord[];
  hypotheses: HypothesisRecord[];
}

const MAX_RUNS = 200;
const MAX_HYPOTHESES = 200;

export function emptyMemory(): AgentMemory {
  return { version: 1, runs: [], hypotheses: [] };
}

export function loadMemory(file: string): AgentMemory {
  if (!existsSync(file)) return emptyMemory();
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<AgentMemory>;
    return { version: 1, runs: Array.isArray(value.runs) ? value.runs : [], hypotheses: Array.isArray(value.hypotheses) ? value.hypotheses : [] };
  } catch {
    return emptyMemory();
  }
}

export function saveMemory(file: string, memory: AgentMemory): void {
  memory.runs = memory.runs.slice(-MAX_RUNS);
  memory.hypotheses = memory.hypotheses.slice(-MAX_HYPOTHESES);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(memory, null, 2));
  renameSync(tmp, file);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

interface GhPrView {
  state?: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  reviews?: Array<{ body?: string; state?: string; author?: { login?: string } }>;
  comments?: Array<{ body?: string; author?: { login?: string } }>;
}

/** Updates open PR hypotheses with their merged/closed state and review feedback via `gh pr view`. */
export async function refreshPrOutcomes(memory: AgentMemory, runner: CommandRunner, repoPath: string, now = new Date()): Promise<string[]> {
  const notes: string[] = [];
  for (const hypothesis of memory.hypotheses) {
    if (hypothesis.status !== "pr-open" || hypothesis.prNumber === undefined) continue;
    const result = await runner.run("gh", ["pr", "view", String(hypothesis.prNumber), "--json", "state,mergedAt,closedAt,reviews,comments"], {
      cwd: repoPath,
      timeoutMs: 60_000
    });
    if (result.code !== 0) {
      notes.push(`gh pr view #${hypothesis.prNumber} failed: ${clip(result.stderr, 200)}`);
      continue;
    }
    let view: GhPrView;
    try {
      view = JSON.parse(result.stdout) as GhPrView;
    } catch {
      continue;
    }
    const feedback = [
      ...(view.reviews ?? []).filter((review) => review.body?.trim()).map((review) => `${review.state ?? "REVIEW"} by ${review.author?.login ?? "?"}: ${clip(review.body ?? "", 300)}`),
      ...(view.comments ?? []).filter((comment) => comment.body?.trim()).map((comment) => `comment by ${comment.author?.login ?? "?"}: ${clip(comment.body ?? "", 300)}`)
    ].slice(-6);
    if (feedback.length) hypothesis.feedback = feedback;
    const state = (view.state ?? "").toUpperCase();
    if (state === "MERGED" || view.mergedAt) hypothesis.status = "merged";
    else if (state === "CLOSED") hypothesis.status = "closed";
    hypothesis.checkedAt = now.toISOString();
    if (hypothesis.status !== "pr-open") notes.push(`PR #${hypothesis.prNumber} is now ${hypothesis.status}`);
  }
  return notes;
}

/** Compact memory text for prompts: what was accepted, rejected or failed, and recent findings. */
export function memoryForPrompt(memory: AgentMemory, maxChars: number): string {
  const sections: string[] = [];
  const describe = (h: HypothesisRecord) =>
    `- [${h.status}] ${clip(h.title, 120)}${h.prNumber ? ` (PR #${h.prNumber})` : ""} files=${h.files.slice(0, 4).join(",")}${h.reason ? ` reason: ${clip(h.reason, 160)}` : ""}${
      h.feedback?.length ? ` feedback: ${h.feedback.map((f) => clip(f, 160)).join(" / ")}` : ""
    }`;
  const rejected = memory.hypotheses.filter((h) => h.status === "closed" || h.status === "abandoned" || h.status === "invalid").slice(-8);
  const accepted = memory.hypotheses.filter((h) => h.status === "merged").slice(-8);
  const open = memory.hypotheses.filter((h) => h.status === "pr-open").slice(-4);
  const dry = memory.hypotheses.filter((h) => h.status === "dry-run").slice(-4);
  if (rejected.length) sections.push(`Rejected / failed ideas (do NOT re-propose without new evidence):\n${rejected.map(describe).join("\n")}`);
  if (accepted.length) sections.push(`Accepted (merged) changes (build on these, do not redo):\n${accepted.map(describe).join("\n")}`);
  if (open.length) sections.push(`Open AI PRs awaiting review (do not duplicate):\n${open.map(describe).join("\n")}`);
  if (dry.length) sections.push(`Recent dry-run proposals:\n${dry.map(describe).join("\n")}`);
  const recent = memory.runs.filter((run) => run.decision !== "skipped").slice(-5);
  if (recent.length) {
    sections.push(
      `Recent runs:\n${recent
        .map((run) => `- ${run.at} [${run.decision}/${run.severity}] ${clip(run.digestSummary, 220)}${run.findings.length ? ` findings: ${run.findings.map((f) => clip(f, 100)).join(" | ")}` : ""}`)
        .join("\n")}`
    );
  }
  let text = sections.join("\n\n") || "(no prior memory)";
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 20)}\n…[memory truncated]`;
  return text;
}
