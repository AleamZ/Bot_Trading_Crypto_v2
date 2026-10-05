export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  added: string[];
  removed: string[];
  isNew: boolean;
  isDeleted: boolean;
  headerFlags: string[];
}

export interface DiffLimits {
  maxFiles: number;
  maxChangedLines: number;
}

export interface DiffValidationResult {
  ok: boolean;
  errors: string[];
  files: DiffFile[];
  /** All repo paths touched (old and new). */
  paths: string[];
  changedLines: number;
}

/** Paths the agent may change. Everything else is rejected. */
export const ALLOWED_PATH_PATTERNS: RegExp[] = [
  /^apps\/api\/src\/.+/,
  /^apps\/api\/tests\/.+/,
  /^apps\/web\/.+/,
  /^docs\/.+/,
  /^trading_rules\.md$/
];

/** Always forbidden, even if inside an allowed tree. */
export const FORBIDDEN_PATH_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\/)\.env[^/]*$/i, reason: "environment files (.env*)" },
  { pattern: /(^|\/)ecosystem\.config\.cjs$/i, reason: "pm2 ecosystem config" },
  { pattern: /(^|\/)deploy-api\.sh$/i, reason: "deploy script" },
  { pattern: /(^|\/)package(-lock)?[^/]*\.json$/i, reason: "package*.json" },
  { pattern: /^tools\/ai-dev-agent(\/|$)/i, reason: "self-modification of the AI Dev Agent" },
  { pattern: /^apps\/api\/src\/infrastructure\/execution\/LockedRealExecutionGateway\.ts$/i, reason: "real-execution lock gateway" },
  { pattern: /^apps\/api\/src\/application\/execution\/RealExecutionProposal[^/]*$/i, reason: "real-execution proposal flow" },
  { pattern: /^apps\/api\/src\/application\/runtime\/ExecutionPolicy\.ts$/i, reason: "execution policy" },
  { pattern: /(^|\/)\.git(\/|$)/i, reason: "git internals" },
  { pattern: /(^|\/)\.github(\/|$)/i, reason: "CI configuration" },
  { pattern: /(^|\/)\.claude(\/|$)/i, reason: "agent configuration" }
];

/**
 * Content guard on every added or removed line: touching any of these tokens could
 * flip real-money execution behaviour (lock, live flag, mode, mainnet/testnet routing).
 */
export const FORBIDDEN_CONTENT_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /realLiveExecutionEnabled/i, reason: "realLiveExecutionEnabled" },
  { pattern: /REAL_LIVE_EXECUTION_ENABLED/i, reason: "REAL_LIVE_EXECUTION_ENABLED" },
  { pattern: /REAL_EXECUTION_LOCKED/, reason: "REAL_EXECUTION_LOCKED" },
  { pattern: /realExecutionMode|REAL_EXECUTION_MODE/, reason: "realExecutionMode" },
  { pattern: /LockedRealExecutionGateway/, reason: "LockedRealExecutionGateway" },
  { pattern: /RealExecutionProposal/, reason: "RealExecutionProposal" },
  { pattern: /\bExecutionPolicy\b|resolveExecutionPolicy/, reason: "ExecutionPolicy" },
  { pattern: /\b(testnet|mainnet)\b/i, reason: "testnet/mainnet routing" },
  { pattern: /\bchild_process\b|\bexecSync\b|\bspawnSync\b/, reason: "process spawning" },
  { pattern: /(api[_-]?secret|api[_-]?key|private[_-]?key)\s*[:=]\s*["'`][A-Za-z0-9]{16,}/i, reason: "hard-coded credential" }
];

function stripPrefix(path: string): string | null {
  const trimmed = path.trim().replace(/\t.*$/, "");
  if (trimmed === "/dev/null") return null;
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return unquoted.replace(/^[ab]\//, "");
}

export function normalizeDiff(diff: string): string {
  let text = diff.replace(/\r\n/g, "\n");
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

/** Minimal unified-diff parser (git style or plain ---/+++). */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const lines = normalizeDiff(diff).split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let inHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  const start = (): DiffFile => {
    const file: DiffFile = { oldPath: null, newPath: null, added: [], removed: [], isNew: false, isDeleted: false, headerFlags: [] };
    files.push(file);
    inHunk = false;
    return file;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (inHunk && current && (oldRemaining > 0 || newRemaining > 0)) {
      if (line.startsWith("+")) {
        current.added.push(line.slice(1));
        newRemaining -= 1;
        continue;
      }
      if (line.startsWith("-")) {
        current.removed.push(line.slice(1));
        oldRemaining -= 1;
        continue;
      }
      if (line.startsWith(" ") || line === "") {
        oldRemaining -= 1;
        newRemaining -= 1;
        continue;
      }
      if (line.startsWith("\\")) continue;
      inHunk = false;
    }
    if (line.startsWith("diff --git ")) {
      current = start();
      const match = /^diff --git (\S+) (\S+)$/.exec(line);
      if (match) {
        current.oldPath = stripPrefix(match[1] ?? "");
        current.newPath = stripPrefix(match[2] ?? "");
      } else {
        current.headerFlags.push("unparseable diff --git header");
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      const next = lines[i + 1] ?? "";
      if (!next.startsWith("+++ ")) continue;
      if (!current || current.added.length > 0 || current.removed.length > 0 || inHunk) current = start();
      current.oldPath = stripPrefix(line.slice(4));
      current.newPath = stripPrefix(next.slice(4));
      if (current.oldPath === null) current.isNew = true;
      if (current.newPath === null) current.isDeleted = true;
      i += 1;
      continue;
    }
    if (!current) continue;
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldRemaining = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (line.startsWith("new file mode")) {
      current.isNew = true;
      if (!/^new file mode 100(644|755)$/.test(line)) current.headerFlags.push(line);
    } else if (line.startsWith("deleted file mode")) current.isDeleted = true;
    else if (/^(old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to)/.test(line)) current.headerFlags.push(line);
    else if (line.startsWith("GIT binary patch") || line.startsWith("Binary files")) current.headerFlags.push("binary patch");
  }
  return files;
}

export function checkPath(path: string): string | null {
  if (path.includes("\\")) return `${path}: backslashes are not allowed in paths`;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return `${path}: absolute paths are not allowed`;
  if (path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) return `${path}: path traversal / empty segments are not allowed`;
  if (/[\0\n\r]/.test(path)) return `${path}: control characters`;
  for (const rule of FORBIDDEN_PATH_RULES) {
    if (rule.pattern.test(path)) return `${path}: forbidden (${rule.reason})`;
  }
  if (!ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(path))) return `${path}: outside the allowed paths`;
  return null;
}

export function validateDiff(diff: string, limits: DiffLimits): DiffValidationResult {
  const errors: string[] = [];
  if (!diff || diff.trim() === "") {
    return { ok: false, errors: ["empty diff"], files: [], paths: [], changedLines: 0 };
  }
  const files = parseUnifiedDiff(diff);
  if (files.length === 0) errors.push("no file sections found in diff");
  const paths = new Set<string>();
  let changedLines = 0;
  for (const file of files) {
    if (file.oldPath === null && file.newPath === null) errors.push("file section without paths");
    if (file.oldPath !== null && file.newPath !== null && file.oldPath !== file.newPath) {
      errors.push(`rename/copy not allowed: ${file.oldPath} -> ${file.newPath}`);
    }
    for (const flag of file.headerFlags) errors.push(`unsupported diff header (${file.newPath ?? file.oldPath}): ${flag}`);
    for (const path of [file.oldPath, file.newPath]) {
      if (path === null) continue;
      paths.add(path);
      const problem = checkPath(path);
      if (problem) errors.push(problem);
    }
    if (file.added.length === 0 && file.removed.length === 0 && !file.isDeleted) {
      errors.push(`no changes in section for ${file.newPath ?? file.oldPath}`);
    }
    changedLines += file.added.length + file.removed.length;
    for (const [kind, list] of [
      ["added", file.added],
      ["removed", file.removed]
    ] as const) {
      for (const text of list) {
        for (const rule of FORBIDDEN_CONTENT_RULES) {
          if (rule.pattern.test(text)) {
            errors.push(`${file.newPath ?? file.oldPath}: ${kind} line touches forbidden token (${rule.reason})`);
          }
        }
      }
    }
  }
  if (paths.size > limits.maxFiles) errors.push(`too many files: ${paths.size} > MAX_FILES=${limits.maxFiles}`);
  if (changedLines > limits.maxChangedLines) errors.push(`too many changed lines: ${changedLines} > MAX_CHANGED_LINES=${limits.maxChangedLines}`);
  return { ok: errors.length === 0, errors: [...new Set(errors)], files, paths: [...paths].sort(), changedLines };
}
