import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CommandRunner } from "./commandRunner.js";
import type { AgentConfig } from "./config.js";
import { aggregate, emptyDigest, renderDigest, summarizeDigest, type Digest } from "./digest.js";
import { checkPath, normalizeDiff, validateDiff, type DiffValidationResult } from "./diffValidator.js";
import { GitOps, branchName } from "./git.js";
import { checkOpenPrGate, createPullRequest, ensureLabel } from "./github.js";
import { DiagnosisSchema, extractJson, extractPatch, type Diagnosis, type LlmClient, type Patch } from "./llm.js";
import { loadCursorState, readNewLines, saveCursorState, type CursorState } from "./logs/logReader.js";
import { parseLogLine, type ParsedLogLine } from "./logs/parseLine.js";
import { loadMemory, memoryForPrompt, refreshPrOutcomes, saveMemory, type AgentMemory, type HypothesisRecord, type RunDecision, type RunRecord } from "./memory.js";
import { diagnosePrompt, fixPrompt, patchPrompt } from "./prompts.js";
import { tail, type StepResult, type Toolchain } from "./toolchain.js";

export interface CycleDeps {
  config: AgentConfig;
  runner: CommandRunner;
  llm: LlmClient;
  toolchain: Toolchain;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface CycleOptions {
  digestOnly?: boolean;
  /** Ignore MIN_NEW_LINES / MIN_SIGNAL_EVENTS. */
  force?: boolean;
  /** Override LOG_PATHS (digest-only against a fixture). */
  logPaths?: string[];
  /** Read from the beginning of the files, ignoring the cursor (digest-only). */
  fromStart?: boolean;
}

export interface CycleResult {
  decision: RunDecision;
  detail: string;
  digestText?: string;
  reportPath?: string;
  branch?: string;
  prUrl?: string;
}

export const MEMORY_FILE = "memory.json";
export const CURSOR_FILE = "cursors.json";

interface LogCollection {
  digest: Digest;
  cursors: CursorState;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

export function collectLogs(paths: string[], cursors: CursorState, maxBytes: number, fromStart = false): LogCollection {
  const digest = emptyDigest();
  const next: CursorState = { ...cursors };
  for (const path of paths) {
    const chunk = readNewLines(path, fromStart ? undefined : cursors[path], maxBytes);
    if (!chunk) continue;
    const defaultLevel = /error/i.test(basename(path)) ? "error" : "unknown";
    const parsed: ParsedLogLine[] = [];
    for (const line of chunk.lines) {
      const entry = parseLogLine(line, defaultLevel);
      if (entry) parsed.push(entry);
    }
    aggregate(parsed, digest);
    next[path] = chunk.nextCursor;
  }
  return { digest, cursors: next };
}

/** Paths the LLM may ask to read: allowed-to-edit trees, no secrets, no traversal. */
export function isReadablePath(path: string): boolean {
  if (checkPath(path) === null) return true;
  // Reading (not editing) the protected execution files is fine for context.
  return /^apps\/api\/src\/.+\.ts$/.test(path) && !/(^|\/)\.env/i.test(path) && !path.split("/").includes("..");
}

export class AgentCycle {
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly git: GitOps;
  private readonly memoryFile: string;
  private readonly cursorFile: string;

  constructor(private readonly deps: CycleDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((message) => console.log(`[ai-dev-agent] ${message}`));
    this.git = new GitOps(deps.runner, deps.config.repoPath, deps.config.remote, deps.config.worktreeDir);
    this.memoryFile = join(deps.config.stateDir, MEMORY_FILE);
    this.cursorFile = join(deps.config.stateDir, CURSOR_FILE);
  }

  private get config(): AgentConfig {
    return this.deps.config;
  }

  private get baseRef(): string {
    return `${this.config.remote}/${this.config.baseBranch}`;
  }

  async run(options: CycleOptions = {}): Promise<CycleResult> {
    const startedAt = this.now();
    const cursors = loadCursorState(this.cursorFile);
    const { digest, cursors: nextCursors } = collectLogs(options.logPaths ?? this.config.logPaths, cursors, this.config.maxReadBytes, options.fromStart);
    const digestText = renderDigest(digest, this.config.digestMaxChars);

    if (options.digestOnly) {
      return { decision: "skipped", detail: "digest-only", digestText };
    }

    const enough = digest.totalLines >= this.config.minNewLines || digest.signalEvents >= this.config.minSignalEvents;
    if (!options.force && (!enough || digest.totalLines === 0)) {
      const detail = `not enough new signal (lines=${digest.totalLines}/${this.config.minNewLines}, signalEvents=${digest.signalEvents}/${this.config.minSignalEvents}); cursor kept`;
      this.log(detail);
      return { decision: "skipped", detail, digestText };
    }

    const memory = loadMemory(this.memoryFile);
    const commitCursor = () => saveCursorState(this.cursorFile, nextCursors);
    const run: RunRecord = {
      id: stamp(startedAt),
      at: startedAt.toISOString(),
      window: digest.window,
      lines: digest.totalLines,
      digestSummary: summarizeDigest(digest),
      severity: "none",
      findings: [],
      decision: "error"
    };
    const finish = (result: CycleResult, extra: Partial<RunRecord> = {}): CycleResult => {
      Object.assign(run, extra, { decision: result.decision, detail: oneLine(result.detail, 500) });
      if (result.branch) run.branch = result.branch;
      if (result.prUrl) run.prUrl = result.prUrl;
      memory.runs.push(run);
      saveMemory(this.memoryFile, memory);
      return { ...result, digestText };
    };

    const prNotes = await refreshPrOutcomes(memory, this.deps.runner, this.config.repoPath, startedAt).catch((error: unknown) => [String(error)]);
    for (const note of prNotes) this.log(note);

    const fetched = await this.git.fetch();
    if (fetched.code !== 0) this.log(`git fetch failed: ${fetched.stderr.trim().slice(0, 300)}`);
    if (!(await this.git.refExists(this.baseRef))) {
      const detail = `${this.baseRef} does not exist; push ${this.config.baseBranch} to ${this.config.remote} first`;
      return finish({ decision: "error", detail, reportPath: this.writeReport("error", digestText, detail, memory) });
    }

    const tradingRules = (await this.git.showFile(this.baseRef, "trading_rules.md")) ?? this.readLocal("trading_rules.md") ?? "(trading_rules.md not found)";
    const skillDoc = (await this.git.showFile(this.baseRef, "docs/ai/bot-analysis-skill.md")) ?? this.readLocal("docs/ai/bot-analysis-skill.md");
    const memoryText = memoryForPrompt(memory, 3_500);

    // ---- LLM step 1: diagnose
    let diagnosis: Diagnosis;
    try {
      const raw = await this.deps.llm.complete(
        diagnosePrompt({ digest: digestText, memory: memoryText, tradingRules, skillDoc, maxReadFiles: this.config.maxReadFiles })
      );
      diagnosis = extractJson(raw, DiagnosisSchema);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transport = /fetch failed|abort|ECONNREFUSED|LLM HTTP|timeout/i.test(message);
      if (!transport) commitCursor();
      const detail = `diagnose step failed: ${message}${transport ? " (cursor kept, will retry)" : ""}`;
      this.log(detail);
      return finish({ decision: "error", detail, reportPath: this.writeReport("error", digestText, detail, memory) });
    }
    run.severity = diagnosis.severity;
    run.findings = diagnosis.findings.map((finding) => oneLine(finding.title, 160)).slice(0, 8);
    commitCursor();

    if (!diagnosis.codeChangeWarranted) {
      const detail = `no code change warranted (severity=${diagnosis.severity})`;
      this.log(detail);
      return finish({ decision: "no-change", detail, reportPath: this.writeReport("no-change", digestText, detail, memory, { diagnosis }) });
    }

    const gate = await checkOpenPrGate(this.deps.runner, this.config.repoPath, this.config.maxOpenAiPrs, this.config.dryRun);
    if (!gate.allowed) {
      const detail = `PR gate closed: ${gate.reason} - report only`;
      this.log(detail);
      return finish({ decision: "blocked-open-pr", detail, reportPath: this.writeReport("blocked", digestText, detail, memory, { diagnosis }) });
    }

    // ---- read requested files from the base branch
    const files: Array<{ path: string; content: string }> = [];
    for (const path of diagnosis.filesToRead.map((p) => p.trim().replace(/^\.\//, "")).filter(isReadablePath).slice(0, this.config.maxReadFiles)) {
      const content = await this.git.showFile(this.baseRef, path);
      if (content === null) continue;
      files.push({
        path,
        content: content.length > this.config.maxFileChars ? `${content.slice(0, this.config.maxFileChars)}\n…[truncated at ${this.config.maxFileChars} chars]` : content
      });
    }

    const patchContext = {
      diagnosis,
      digest: digestText,
      memory: memoryText,
      files,
      maxFiles: this.config.maxFiles,
      maxChangedLines: this.config.maxChangedLines,
      baseBranch: this.config.baseBranch
    };

    // ---- LLM step 2: patch
    let patch: Patch;
    try {
      patch = extractPatch(await this.deps.llm.complete(patchPrompt(patchContext)));
    } catch (error) {
      const detail = `patch step failed: ${error instanceof Error ? error.message : String(error)}`;
      this.recordHypothesis(memory, diagnosis, { title: diagnosis.proposal || "patch step failed", body: "", diff: "" }, [], "invalid", detail);
      return finish({ decision: "invalid-diff", detail, reportPath: this.writeReport("invalid", digestText, detail, memory, { diagnosis }) });
    }

    let branch = branchName(patch.title, this.now());
    for (let suffix = 2; suffix < 10 && (await this.git.refExists(`refs/heads/${branch}`)); suffix += 1) {
      branch = `${branchName(patch.title, this.now()).slice(0, 60)}-${suffix}`;
    }
    const worktree = join(this.config.worktreeDir, branch.replace(/\//g, "_"));
    let worktreeReady = false;
    let validation: DiffValidationResult | null = null;
    let typecheck: StepResult | null = null;
    let tests: StepResult | null = null;
    let lastFailure = "";
    const attempts: string[] = [];

    const cleanupWorktree = async () => {
      if (!worktreeReady) return;
      this.deps.toolchain.cleanup(worktree);
      await this.git.removeWorktree(worktree, branch);
      worktreeReady = false;
    };

    try {
      for (let attempt = 0; attempt <= this.config.maxFixAttempts; attempt += 1) {
        if (attempt > 0) {
          this.log(`asking LLM to fix the patch (attempt ${attempt}/${this.config.maxFixAttempts})`);
          try {
            const fixed = extractPatch(
              await this.deps.llm.complete(fixPrompt({ ...patchContext, previousDiff: patch.diff, failure: tail(lastFailure, 6_000), attempt }))
            );
            patch = { title: patch.title, body: fixed.body || patch.body, diff: fixed.diff };
          } catch (error) {
            lastFailure = `fix step failed: ${error instanceof Error ? error.message : String(error)}`;
            attempts.push(lastFailure);
            continue;
          }
        }
        patch.diff = normalizeDiff(patch.diff);
        validation = validateDiff(patch.diff, { maxFiles: this.config.maxFiles, maxChangedLines: this.config.maxChangedLines });
        if (!validation.ok) {
          lastFailure = `diff validation failed:\n- ${validation.errors.join("\n- ")}`;
          attempts.push(lastFailure);
          this.log(lastFailure);
          // Security-relevant violations are never sent back for "fixing".
          if (validation.errors.some((e) => /forbidden|outside the allowed|traversal|absolute|rename|binary|mode/.test(e))) break;
          continue;
        }

        if (!worktreeReady) {
          mkdirSync(this.config.worktreeDir, { recursive: true });
          await this.git.addWorktree(worktree, branch, this.baseRef);
          worktreeReady = true;
          const install = await this.deps.toolchain.install(worktree);
          if (!install.ok) {
            lastFailure = `dependency install failed:\n${tail(install.output)}`;
            attempts.push(lastFailure);
            break;
          }
        } else {
          await this.git.resetHard(worktree);
        }

        const patchDir = join(this.config.stateDir, "patches");
        mkdirSync(patchDir, { recursive: true });
        const patchFile = join(patchDir, `${branch.replace(/\//g, "_")}-${attempt}.diff`);
        writeFileSync(patchFile, patch.diff);
        const check = await this.git.applyCheck(worktree, patchFile);
        if (check.code !== 0) {
          lastFailure = `git apply --check failed:\n${tail(check.stderr || check.stdout, 3_000)}`;
          attempts.push(lastFailure);
          continue;
        }
        const applied = await this.git.apply(worktree, patchFile);
        if (applied.code !== 0) {
          lastFailure = `git apply failed:\n${tail(applied.stderr, 3_000)}`;
          attempts.push(lastFailure);
          continue;
        }
        await this.git.stage(worktree, validation.paths);
        // Defense in depth: what git actually changed must equal what we validated.
        const changed = (await this.git.status(worktree)).filter((path) => path !== "node_modules" && path !== "node_modules/");
        const unexpected = changed.filter((path) => !validation!.paths.includes(path));
        const revalidated = validateDiff(await this.git.stagedDiff(worktree), { maxFiles: this.config.maxFiles, maxChangedLines: this.config.maxChangedLines });
        if (unexpected.length > 0 || !revalidated.ok) {
          lastFailure = `post-apply verification failed: unexpected=${unexpected.join(",") || "-"} ${revalidated.errors.join("; ")}`;
          attempts.push(lastFailure);
          break;
        }

        typecheck = await this.deps.toolchain.typecheck(worktree);
        tests = typecheck.ok ? await this.deps.toolchain.test(worktree) : null;
        if (typecheck.ok && tests?.ok) {
          lastFailure = "";
          break;
        }
        lastFailure = typecheck.ok ? `vitest failed:\n${tail(tests?.output ?? "", 5_000)}` : `typecheck failed:\n${tail(typecheck.output, 5_000)}`;
        attempts.push(lastFailure.slice(0, 2_000));
        this.log(lastFailure.split("\n")[0] ?? "checks failed");
      }

      const green = lastFailure === "" && typecheck?.ok === true && tests?.ok === true && validation?.ok === true;
      if (!green || !validation) {
        await cleanupWorktree();
        const detail = `abandoned after ${attempts.length} failed attempt(s): ${oneLine(lastFailure, 400)}`;
        const status = validation && !validation.ok ? "invalid" : "abandoned";
        this.recordHypothesis(memory, diagnosis, patch, validation?.paths ?? [], status, oneLine(lastFailure, 400));
        return finish({
          decision: status === "invalid" ? "invalid-diff" : "abandoned",
          detail,
          branch,
          reportPath: this.writeReport("abandoned", digestText, detail, memory, { diagnosis, patch, attempts })
        });
      }

      const body = this.prBody(digest, digestText, diagnosis, patch, validation, typecheck!, tests!);
      if (this.config.dryRun) {
        const detail = `DRY-RUN: checks are green. Would commit as AI Dev Agent, push ${branch} and run: gh pr create --base ${this.config.baseBranch} --head ${branch} --label ai-generated --title "${oneLine(patch.title)}"`;
        this.log(detail);
        await cleanupWorktree();
        this.recordHypothesis(memory, diagnosis, patch, validation.paths, "dry-run", "dry-run (not published)");
        return finish({ decision: "dry-run", detail, branch, reportPath: this.writeReport("dry-run", digestText, detail, memory, { diagnosis, patch, attempts, prBody: body }) });
      }

      // ---- live: commit, verify, push the ai/ branch, open the PR
      const messageFile = join(this.config.stateDir, "patches", `${branch.replace(/\//g, "_")}-commit.txt`);
      writeFileSync(messageFile, `${oneLine(patch.title)}\n\nAI-generated by the AI Dev Agent from bot logs. Requires human review.\n\n${oneLine(diagnosis.summary, 600)}\n`);
      await this.git.commit(worktree, messageFile);
      const head = await this.git.currentBranch(worktree);
      if (head !== branch) throw new Error(`worktree HEAD is ${head}, expected ${branch}`);
      const committed = await this.git.changedSinceBase(worktree, this.baseRef);
      const outside = committed.filter((path) => !validation!.paths.includes(path) || checkPath(path) !== null);
      if (outside.length) throw new Error(`commit touches unvalidated paths: ${outside.join(", ")}`);
      const gateAgain = await checkOpenPrGate(this.deps.runner, this.config.repoPath, this.config.maxOpenAiPrs, false);
      if (!gateAgain.allowed) {
        await cleanupWorktree();
        const detail = `PR gate closed before push: ${gateAgain.reason}`;
        return finish({ decision: "blocked-open-pr", detail, reportPath: this.writeReport("blocked", digestText, detail, memory, { diagnosis, patch }) });
      }
      await this.git.pushBranch(worktree, branch);
      await ensureLabel(this.deps.runner, this.config.repoPath);
      const bodyFile = join(this.config.stateDir, "patches", `${branch.replace(/\//g, "_")}-body.md`);
      writeFileSync(bodyFile, body);
      const pr = await createPullRequest(this.deps.runner, this.config.repoPath, { base: this.config.baseBranch, head: branch, title: oneLine(patch.title), bodyFile });
      await cleanupWorktree();
      const hypothesis = this.recordHypothesis(memory, diagnosis, patch, validation.paths, "pr-open");
      hypothesis.prUrl = pr.url;
      if (pr.number !== undefined) hypothesis.prNumber = pr.number;
      const detail = `opened PR ${pr.url}`;
      this.log(detail);
      return finish(
        { decision: "pr-opened", detail, branch, prUrl: pr.url, reportPath: this.writeReport("pr", digestText, detail, memory, { diagnosis, patch, attempts, prBody: body }) },
        pr.number !== undefined ? { prNumber: pr.number } : {}
      );
    } catch (error) {
      await cleanupWorktree().catch(() => undefined);
      const detail = `cycle error: ${error instanceof Error ? error.message : String(error)}`;
      this.log(detail);
      return finish({ decision: "error", detail, branch, reportPath: this.writeReport("error", digestText, detail, memory, { diagnosis, patch, attempts }) });
    }
  }

  private readLocal(relative: string): string | null {
    const path = join(this.config.repoPath, relative);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  private recordHypothesis(memory: AgentMemory, diagnosis: Diagnosis, patch: Patch, files: string[], status: HypothesisRecord["status"], reason?: string): HypothesisRecord {
    const record: HypothesisRecord = {
      id: `${stamp(this.now())}-${memory.hypotheses.length}`,
      at: this.now().toISOString(),
      title: oneLine(patch.title || diagnosis.proposal, 200),
      proposal: oneLine(diagnosis.proposal, 500),
      files,
      status
    };
    if (reason) record.reason = reason;
    memory.hypotheses.push(record);
    return record;
  }

  private prBody(
    digest: Digest,
    digestText: string,
    diagnosis: Diagnosis,
    patch: Patch,
    validation: DiffValidationResult,
    typecheck: StepResult,
    tests: StepResult
  ): string {
    const findings = diagnosis.findings.map((f) => `- **${f.title}** - ${f.evidence}${f.hypothesis ? `\n  - Hypothesis: ${f.hypothesis}` : ""}`).join("\n") || "- (none)";
    return `> [!WARNING]
> **AI-generated, requires human review.** Opened automatically by the AI Dev Agent (\`tools/ai-dev-agent\`). It is never merged automatically.

## Log digest summary
\`${summarizeDigest(digest)}\`

<details><summary>Full digest</summary>

\`\`\`
${digestText}
\`\`\`
</details>

## Findings (severity: ${diagnosis.severity})
${diagnosis.summary}

${findings}

## Rationale
${diagnosis.proposal}

${patch.body}

## Change
- Files (${validation.paths.length}): ${validation.paths.map((p) => `\`${p}\``).join(", ")}
- Changed lines: ${validation.changedLines}

## Test results
- \`tsc --noEmit\` (apps/api): ${typecheck.ok ? "PASS" : "FAIL"} (${Math.round(typecheck.durationMs / 1000)}s)
- \`vitest run\` (apps/api): ${tests.ok ? "PASS" : "FAIL"} (${Math.round(tests.durationMs / 1000)}s)

<details><summary>vitest output (tail)</summary>

\`\`\`
${tail(tests.output, 2_500)}
\`\`\`
</details>

---
_AI-generated, requires human review. Base: \`${this.config.baseBranch}\`. Model: \`${this.config.ai.model}\`._
`;
  }

  private writeReport(
    kind: string,
    digestText: string,
    detail: string,
    memory: AgentMemory,
    extra: { diagnosis?: Diagnosis; patch?: Patch; attempts?: string[]; prBody?: string } = {}
  ): string {
    mkdirSync(this.config.reportsDir, { recursive: true });
    const path = join(this.config.reportsDir, `${stamp(this.now())}-${kind}.md`);
    const parts = [
      `# AI Dev Agent report - ${kind}`,
      `- Time: ${this.now().toISOString()}`,
      `- Dry-run: ${this.config.dryRun}`,
      `- Outcome: ${detail}`,
      "",
      "## Digest",
      "```",
      digestText,
      "```"
    ];
    if (extra.diagnosis) {
      parts.push("", `## Diagnosis (severity: ${extra.diagnosis.severity}, codeChangeWarranted: ${extra.diagnosis.codeChangeWarranted})`, extra.diagnosis.summary, "");
      for (const finding of extra.diagnosis.findings) parts.push(`- **${finding.title}**: ${finding.evidence} ${finding.hypothesis ? `- ${finding.hypothesis}` : ""}`);
      if (extra.diagnosis.proposal) parts.push("", "### Proposal", extra.diagnosis.proposal);
      if (extra.diagnosis.filesToRead.length) parts.push("", `Files requested: ${extra.diagnosis.filesToRead.join(", ")}`);
    }
    if (extra.patch) {
      parts.push("", `## Patch: ${extra.patch.title}`, extra.patch.body, "", "```diff", extra.patch.diff.trimEnd(), "```");
    }
    if (extra.attempts?.length) {
      parts.push("", "## Attempts");
      extra.attempts.forEach((attempt, index) => parts.push(`### Attempt ${index + 1}`, "```", tail(attempt, 3_000), "```"));
    }
    if (extra.prBody) parts.push("", "## PR body (as it would be / was submitted)", extra.prBody);
    parts.push("", "## Memory snapshot", memoryForPrompt(memory, 2_000));
    writeFileSync(path, `${parts.join("\n")}\n`);
    return path;
  }
}
