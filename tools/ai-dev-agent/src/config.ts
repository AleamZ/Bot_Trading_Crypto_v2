import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/** Directory of the tool package (tools/ai-dev-agent). */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const intFrom = (fallback: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === "" ? fallback : Number(value)))
    .pipe(z.number().int().min(min));

const rawSchema = z.object({
  AI_BASE_URL: z.string().default("http://localhost:20128/v1"),
  AI_API_KEY: z.string().default(""),
  AI_MODEL: z.string().default("local-model"),
  AI_TIMEOUT_MS: intFrom(300_000, 1_000),
  AI_TEMPERATURE: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === "" ? 0.2 : Number(value)))
    .pipe(z.number().min(0).max(2)),
  LOG_PATHS: z.string().default("logs/smc-futures-api/out.log,logs/smc-futures-api/error.log"),
  REPO_PATH: z.string().default(""),
  BASE_BRANCH: z.string().default("dat-dev"),
  GIT_REMOTE: z.string().default("origin"),
  INTERVAL_MINUTES: intFrom(30, 1),
  MIN_NEW_LINES: intFrom(200, 0),
  MIN_SIGNAL_EVENTS: intFrom(20, 0),
  MAX_READ_BYTES: intFrom(20 * 1024 * 1024, 1024),
  DIGEST_MAX_CHARS: intFrom(6_000, 500),
  MAX_FILES: intFrom(8, 1),
  MAX_CHANGED_LINES: intFrom(400, 1),
  MAX_READ_FILES: intFrom(6, 1),
  MAX_FILE_CHARS: intFrom(14_000, 500),
  MAX_FIX_ATTEMPTS: intFrom(2, 0),
  MAX_OPEN_AI_PRS: intFrom(1, 0),
  WORKTREE_DIR: z.string().default(""),
  WORKTREE_INSTALL: z.enum(["link", "ci"]).default("link"),
  TEST_TIMEOUT_MS: intFrom(15 * 60_000, 10_000),
  AI_DEV_AGENT_DRY_RUN: z.string().default("true")
});

export interface AgentConfig {
  ai: { baseUrl: string; apiKey: string; model: string; timeoutMs: number; temperature: number };
  repoPath: string;
  logPaths: string[];
  baseBranch: string;
  remote: string;
  intervalMinutes: number;
  minNewLines: number;
  minSignalEvents: number;
  maxReadBytes: number;
  digestMaxChars: number;
  maxFiles: number;
  maxChangedLines: number;
  maxReadFiles: number;
  maxFileChars: number;
  maxFixAttempts: number;
  maxOpenAiPrs: number;
  worktreeDir: string;
  worktreeInstall: "link" | "ci";
  testTimeoutMs: number;
  /** Fail-safe: anything other than the literal string "false" keeps dry-run ON. */
  dryRun: boolean;
  stateDir: string;
  reportsDir: string;
}

export function parseDryRun(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() !== "false";
}

export function buildConfig(env: Record<string, string | undefined>, packageDir = PACKAGE_DIR): AgentConfig {
  const raw = rawSchema.parse(env);
  const repoPath = raw.REPO_PATH.trim() ? resolve(packageDir, raw.REPO_PATH.trim()) : resolve(packageDir, "../..");
  const logPaths = raw.LOG_PATHS.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (isAbsolute(entry) ? entry : resolve(repoPath, entry)));
  const baseBranch = raw.BASE_BRANCH.trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(baseBranch) || baseBranch.startsWith("-")) throw new Error(`Invalid BASE_BRANCH: ${baseBranch}`);
  const remote = raw.GIT_REMOTE.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith("-")) throw new Error(`Invalid GIT_REMOTE: ${remote}`);
  return {
    ai: {
      baseUrl: raw.AI_BASE_URL.replace(/\/+$/, ""),
      apiKey: raw.AI_API_KEY,
      model: raw.AI_MODEL,
      timeoutMs: raw.AI_TIMEOUT_MS,
      temperature: raw.AI_TEMPERATURE
    },
    repoPath,
    logPaths,
    baseBranch,
    remote,
    intervalMinutes: raw.INTERVAL_MINUTES,
    minNewLines: raw.MIN_NEW_LINES,
    minSignalEvents: raw.MIN_SIGNAL_EVENTS,
    maxReadBytes: raw.MAX_READ_BYTES,
    digestMaxChars: raw.DIGEST_MAX_CHARS,
    maxFiles: raw.MAX_FILES,
    maxChangedLines: raw.MAX_CHANGED_LINES,
    maxReadFiles: raw.MAX_READ_FILES,
    maxFileChars: raw.MAX_FILE_CHARS,
    maxFixAttempts: raw.MAX_FIX_ATTEMPTS,
    maxOpenAiPrs: raw.MAX_OPEN_AI_PRS,
    worktreeDir: raw.WORKTREE_DIR.trim() ? resolve(packageDir, raw.WORKTREE_DIR.trim()) : resolve(tmpdir(), "ai-dev-agent-worktrees"),
    worktreeInstall: raw.WORKTREE_INSTALL,
    testTimeoutMs: raw.TEST_TIMEOUT_MS,
    dryRun: parseDryRun(raw.AI_DEV_AGENT_DRY_RUN),
    stateDir: resolve(packageDir, "state"),
    reportsDir: resolve(packageDir, "reports")
  };
}

export function loadConfig(): AgentConfig {
  const envFile = resolve(PACKAGE_DIR, ".env");
  if (existsSync(envFile)) loadDotenv({ path: envFile });
  return buildConfig(process.env);
}
