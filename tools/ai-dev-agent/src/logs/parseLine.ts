export type LogLevel = "info" | "warn" | "error" | "debug" | "unknown";

export interface ParsedLogLine {
  /** ISO timestamp if one could be found (log payload first, pm2 prefix second). */
  timestamp: string | null;
  level: LogLevel;
  message: string;
  /** Structured context (production JSON) – empty for dev/raw lines. */
  context: Record<string, unknown>;
  /** Text after "message: " in the dev format, if present. */
  reasonSuffix: string | null;
  format: "json" | "dev" | "raw";
}

/** pm2 `time: true` prefix, e.g. `2026-10-05T10:00:00: ` or `2026-10-05 10:00:00 +07:00: `. */
const PM2_PREFIX = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z| ?[+-]\d{2}:?\d{2})?): /;
const DEV_LINE = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\] (INFO|WARN|ERROR|DEBUG) (.*)$/;

// Known dev-format messages that never carry a reason suffix but may contain ": ".
const KNOWN_MESSAGE_PREFIXES = [
  "[FUNNEL] candidate archived",
  "[ENTRY REJECTED]",
  "Entry plan rejected before risk manager",
  "Execution submission failed",
  "[RUNTIME] reconciliation failed",
  "[RUNTIME] bootstrap failed",
  "[RUNTIME] eager account loading failed",
  "[SCANNER] scan failed"
];

function normalizeLevel(value: unknown): LogLevel {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text === "info" || text === "warn" || text === "error" || text === "debug") return text;
  if (text === "warning") return "warn";
  if (text === "fatal") return "error";
  return "unknown";
}

function splitDevMessage(body: string): { message: string; reason: string | null } {
  for (const prefix of KNOWN_MESSAGE_PREFIXES) {
    if (body === prefix) return { message: prefix, reason: null };
    if (body.startsWith(`${prefix}: `)) return { message: prefix, reason: body.slice(prefix.length + 2) };
  }
  if (body.startsWith("[FUNNEL] ")) {
    // `[FUNNEL] acc/SYM source STAGE` or with `: reason`
    const index = body.indexOf(": ");
    return index >= 0 ? { message: body.slice(0, index), reason: body.slice(index + 2) } : { message: body, reason: null };
  }
  const index = body.indexOf(": ");
  return index >= 0 ? { message: body.slice(0, index), reason: body.slice(index + 2) } : { message: body, reason: null };
}

/**
 * Parses one log line in either the production JSON format
 * (`{timestamp, level, component, message, ...context}`) or the dev format
 * (`[ISO] LEVEL message: reason`). An optional pm2 time prefix is stripped.
 * Lines matching neither are returned as `raw` with `defaultLevel`.
 */
export function parseLogLine(input: string, defaultLevel: LogLevel = "unknown"): ParsedLogLine | null {
  let line = input.replace(/\r$/, "");
  if (line.trim() === "") return null;
  let prefixTimestamp: string | null = null;
  const prefix = PM2_PREFIX.exec(line);
  if (prefix) {
    prefixTimestamp = prefix[1] ?? null;
    line = line.slice(prefix[0].length);
  }
  const trimmed = line.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const { timestamp, level, message, component: _component, ...context } = record;
        if (typeof message === "string") {
          return {
            timestamp: typeof timestamp === "string" ? timestamp : prefixTimestamp,
            level: normalizeLevel(level) === "unknown" ? defaultLevel : normalizeLevel(level),
            message,
            context,
            reasonSuffix: null,
            format: "json"
          };
        }
      }
    } catch {
      // fall through to raw
    }
  }
  const dev = DEV_LINE.exec(trimmed);
  if (dev) {
    const { message, reason } = splitDevMessage(dev[3] ?? "");
    return {
      timestamp: dev[1] ?? prefixTimestamp,
      level: normalizeLevel(dev[2]),
      message,
      context: {},
      reasonSuffix: reason,
      format: "dev"
    };
  }
  return { timestamp: prefixTimestamp, level: defaultLevel, message: trimmed, context: {}, reasonSuffix: null, format: "raw" };
}
