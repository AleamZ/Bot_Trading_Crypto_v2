import type { ChatMessage } from "./llm.js";
import type { Diagnosis } from "./llm.js";

export interface PromptContext {
  digest: string;
  memory: string;
  tradingRules: string;
  skillDoc: string | null;
  maxReadFiles: number;
}

const SYSTEM = `You are the AI Dev Agent for a Binance USD-M Futures ICT/SMC trading bot (TypeScript monorepo: apps/api, apps/web).
You analyse production log digests and propose small, safe, well-tested code improvements that a human will review.
Hard rules:
- trading_rules.md is the strategy source of truth. Never weaken risk controls, never change real-money execution locks,
  live-execution flags, execution policy, mainnet/testnet routing, credentials, deploy or package files.
- Only these paths may be changed: apps/api/src/**, apps/api/tests/**, apps/web/**, docs/**, trading_rules.md.
- Prefer the smallest change that fixes a root cause and add or update vitest tests in apps/api/tests.
- Do not re-propose ideas listed as rejected unless the new evidence is clearly different; build on accepted ones.
- Reply with ONE JSON object only. No prose outside JSON.`;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

export function diagnosePrompt(ctx: PromptContext): ChatMessage[] {
  const user = `# Task: diagnose
Analyse the bot behaviour in the digest. Focus on: setups that met conditions but did not trade, rejection reasons,
archived candidates, protection failures, runtime/scanner errors and funnel drop-offs. Decide whether a code change is warranted.

Return JSON:
{
  "summary": "2-4 sentences",
  "findings": [{"title": "...", "evidence": "numbers from the digest", "hypothesis": "root cause"}],
  "severity": "none|low|medium|high|critical",
  "codeChangeWarranted": true|false,
  "proposal": "what to change and why (empty if no change)",
  "filesToRead": ["repo-relative paths, at most ${ctx.maxReadFiles}, e.g. apps/api/src/application/engine/TradingEngine.ts"]
}
Only set codeChangeWarranted=true if the evidence points to a bug or a clear, testable improvement consistent with trading_rules.md.

${ctx.digest}

## Memory (previous runs and PR outcomes)
${ctx.memory}

## trading_rules.md
${clip(ctx.tradingRules, 7_000)}
${ctx.skillDoc ? `\n## Bot analysis skill (docs/ai/bot-analysis-skill.md)\n${clip(ctx.skillDoc, 7_000)}` : ""}`;
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user }
  ];
}

export interface PatchPromptContext {
  diagnosis: Diagnosis;
  digest: string;
  memory: string;
  files: Array<{ path: string; content: string }>;
  maxFiles: number;
  maxChangedLines: number;
  baseBranch: string;
}

const PATCH_FORMAT = `Return JSON:
{
  "title": "short conventional-commit style title, e.g. fix(engine): ...",
  "body": "markdown: problem, root cause, change, risk",
  "diff": "a unified diff (git format, paths prefixed a/ and b/) that applies cleanly to the files shown, including tests"
}
Diff rules: no renames, no binary files, no file-mode changes, at most {MAX_FILES} files and {MAX_LINES} changed lines,
only allowed paths. Hunk headers must have correct line counts. Escape newlines inside the JSON string as \\n.
If you cannot embed the diff in JSON reliably, put it in a separate \`\`\`diff fenced block and leave "diff" empty.`;

function patchFormat(maxFiles: number, maxChangedLines: number): string {
  return PATCH_FORMAT.replace("{MAX_FILES}", String(maxFiles)).replace("{MAX_LINES}", String(maxChangedLines));
}

function renderFiles(files: Array<{ path: string; content: string }>): string {
  return files.map((file) => `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``).join("\n\n");
}

export function patchPrompt(ctx: PatchPromptContext): ChatMessage[] {
  const user = `# Task: write the patch
Base branch: ${ctx.baseBranch}. Implement the proposal below as a minimal change with vitest tests.

## Diagnosis
${JSON.stringify(ctx.diagnosis, null, 2)}

${ctx.digest}

## Memory
${ctx.memory}

## Current file contents (from ${ctx.baseBranch})
${renderFiles(ctx.files)}

${patchFormat(ctx.maxFiles, ctx.maxChangedLines)}`;
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user }
  ];
}

export function fixPrompt(ctx: PatchPromptContext & { previousDiff: string; failure: string; attempt: number }): ChatMessage[] {
  const user = `# Task: fix the patch (attempt ${ctx.attempt})
Your previous diff was applied to a clean checkout of ${ctx.baseBranch} but validation failed.
Produce a NEW complete diff against the ORIGINAL files (not on top of the previous diff).

## Diagnosis
${JSON.stringify(ctx.diagnosis, null, 2)}

## Previous diff
\`\`\`diff
${clip(ctx.previousDiff, 20_000)}
\`\`\`

## Failure output
\`\`\`
${ctx.failure}
\`\`\`

## Original file contents
${renderFiles(ctx.files)}

${patchFormat(ctx.maxFiles, ctx.maxChangedLines)}`;
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user }
  ];
}
