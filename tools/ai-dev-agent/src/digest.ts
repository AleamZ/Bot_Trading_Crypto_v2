import type { ParsedLogLine } from "./logs/parseLine.js";

export interface ErrorSample {
  key: string;
  level: string;
  count: number;
  sample: string;
  firstAt: string | null;
  lastAt: string | null;
}

export interface SymbolFunnel {
  stages: Record<string, number>;
  planRejectReasons: Record<string, number>;
  riskRejectReasons: Record<string, number>;
  archiveReasons: Record<string, number>;
}

export interface Digest {
  window: { from: string | null; to: string | null };
  totalLines: number;
  parsedByFormat: Record<string, number>;
  levels: Record<string, number>;
  entryRejected: Record<string, number>;
  planRejected: Record<string, number>;
  planRejectedClassification: Record<string, number>;
  archiveReasons: Record<string, number>;
  executionFailures: Record<string, number>;
  runtimeFailures: Record<string, number>;
  scannerFailures: number;
  protectionIssues: number;
  funnelTotals: Record<string, number>;
  funnelBySymbol: Record<string, SymbolFunnel>;
  trades: {
    /** Funnel RISK_PASSED events: an order submission was attempted. */
    riskPassed: number;
    executionFailed: number;
    /** Lines that explicitly confirm an order/position (OrderSubmitted, ENTRY_ACCEPTED, POSITION_PROTECTED...). */
    confirmations: number;
    /** riskPassed - executionFailed, floored at 0 (best-effort estimate). */
    estimatedPlaced: number;
  };
  errors: ErrorSample[];
  /** Raw "at ..." stack-trace lines (counted, not sampled). */
  stackFrames: number;
  /** Sum of rejection/archive/failure events – used for the "enough signal" gate. */
  signalEvents: number;
}

/** Canonical funnel order, used for the drop-off summary. */
export const FUNNEL_ORDER = [
  "SCAN_EVALUATED",
  "HTF_TREND_STATE_VALID",
  "HTF_FVG_SELECTED",
  "WAITING_HTF_FIRST_TOUCH",
  "HTF_FIRST_TOUCH_CONFIRMED",
  "LTF_FVG_SELECTED",
  "LTF_FIRST_TOUCH_CONFIRMED",
  "ENTRY_PLAN_REJECTED",
  "ENTRY_PLAN_CREATED",
  "RR_GATE_PASSED",
  "RR_GATE_REJECTED",
  "RISK_MANAGER_REACHED",
  "RISK_REJECTED",
  "RISK_PASSED"
];

const FUNNEL_RE = /^\[FUNNEL\] ([^/\s]+)\/(\S+) (\S+) ([A-Z0-9_]+)$/;
const CONFIRMATION_RE = /\b(OrderSubmitted|ENTRY_ACCEPTED|POSITION_PROTECTED|Submitted \S+ bracket order)\b/;
const PROTECTION_RE = /PROTECTION_INCOMPLETE|\[ACCOUNT PROTECTION\]|protection (failed|incomplete|missing)|missing (TP|SL|stop|take ?profit)/i;

export function emptyDigest(): Digest {
  return {
    window: { from: null, to: null },
    totalLines: 0,
    parsedByFormat: {},
    levels: {},
    entryRejected: {},
    planRejected: {},
    planRejectedClassification: {},
    archiveReasons: {},
    executionFailures: {},
    runtimeFailures: {},
    scannerFailures: 0,
    protectionIssues: 0,
    funnelTotals: {},
    funnelBySymbol: {},
    trades: { riskPassed: 0, executionFailed: 0, confirmations: 0, estimatedPlaced: 0 },
    errors: [],
    stackFrames: 0,
    signalEvents: 0
  };
}

function inc(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function symbolFunnel(digest: Digest, symbol: string): SymbolFunnel {
  let entry = digest.funnelBySymbol[symbol];
  if (!entry) {
    entry = { stages: {}, planRejectReasons: {}, riskRejectReasons: {}, archiveReasons: {} };
    digest.funnelBySymbol[symbol] = entry;
  }
  return entry;
}

/** Collapses volatile parts (ids, numbers, quoted values) so repeated errors dedupe. */
export function normalizeErrorKey(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<ts>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/-?\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const SECRET_KEY_RE = /secret|token|password|credential|apikey|api_key|signature/i;

function compactContext(context: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (SECRET_KEY_RE.test(key)) continue;
    if (value === undefined || value === null) continue;
    const rendered = typeof value === "object" ? JSON.stringify(value) : String(value);
    parts.push(`${key}=${truncate(rendered, 80)}`);
    if (parts.length >= 6) break;
  }
  return parts.join(" ");
}

export function aggregate(lines: ParsedLogLine[], digest: Digest = emptyDigest()): Digest {
  const errors = new Map<string, ErrorSample>(digest.errors.map((sample) => [sample.key, sample]));
  for (const line of lines) {
    digest.totalLines += 1;
    inc(digest.parsedByFormat, line.format);
    inc(digest.levels, line.level);
    if (line.timestamp) {
      if (!digest.window.from || line.timestamp < digest.window.from) digest.window.from = line.timestamp;
      if (!digest.window.to || line.timestamp > digest.window.to) digest.window.to = line.timestamp;
    }
    const ctx = line.context;
    const reason = str(ctx.reason) ?? line.reasonSuffix;
    const message = line.message;
    let categorized = false;

    const funnel = FUNNEL_RE.exec(message);
    if (funnel) {
      categorized = true;
      const symbol = str(ctx.symbol) ?? funnel[2] ?? "UNKNOWN";
      const stage = str(ctx.stage) ?? funnel[4] ?? "UNKNOWN";
      inc(digest.funnelTotals, stage);
      const perSymbol = symbolFunnel(digest, symbol);
      inc(perSymbol.stages, stage);
      if (stage === "ENTRY_PLAN_REJECTED") inc(perSymbol.planRejectReasons, reason ?? "UNKNOWN");
      if (stage === "RISK_REJECTED") inc(perSymbol.riskRejectReasons, reason ?? "UNKNOWN");
      if (stage === "RISK_PASSED") digest.trades.riskPassed += 1;
    } else if (message.startsWith("[FUNNEL] candidate archived")) {
      categorized = true;
      const archiveReason = reason ?? "UNKNOWN";
      inc(digest.archiveReasons, archiveReason);
      inc(symbolFunnel(digest, str(ctx.symbol) ?? "UNKNOWN").archiveReasons, archiveReason);
      digest.signalEvents += 1;
    } else if (message.startsWith("[ENTRY REJECTED]")) {
      categorized = true;
      inc(digest.entryRejected, reason ?? "UNKNOWN");
      digest.signalEvents += 1;
    } else if (message.startsWith("Entry plan rejected before risk manager")) {
      categorized = true;
      inc(digest.planRejected, reason ?? "UNKNOWN");
      inc(digest.planRejectedClassification, str(ctx.classification) ?? "UNKNOWN");
      digest.signalEvents += 1;
    } else if (message.startsWith("Execution submission failed")) {
      categorized = true;
      inc(digest.executionFailures, str(ctx.code) ?? reason ?? "UNKNOWN");
      digest.trades.executionFailed += 1;
      digest.signalEvents += 1;
    } else if (/^\[RUNTIME\] .*failed/.test(message)) {
      categorized = true;
      inc(digest.runtimeFailures, message.replace(/^\[RUNTIME\] /, ""));
      digest.signalEvents += 1;
    } else if (message.startsWith("[SCANNER] scan failed")) {
      categorized = true;
      digest.scannerFailures += 1;
      digest.signalEvents += 1;
    }

    const flat = `${message} ${reason ?? ""} ${str(ctx.code) ?? ""} ${str(ctx.status) ?? ""}`;
    if (CONFIRMATION_RE.test(flat)) digest.trades.confirmations += 1;
    if (PROTECTION_RE.test(flat) && line.level !== "info") {
      digest.protectionIssues += 1;
      digest.signalEvents += 1;
    }

    const isProblem = line.level === "error" || line.level === "warn";
    const stackFrame = line.format === "raw" && /^at\s/.test(message);
    if (stackFrame) digest.stackFrames += 1;
    const keepSample = isProblem && !stackFrame && (!categorized || /failed/i.test(message));
    if (keepSample) {
      const detail = reason ?? str(ctx.error) ?? "";
      const text = detail ? `${message}: ${detail}` : message;
      const key = normalizeErrorKey(text);
      const existing = errors.get(key);
      if (existing) {
        existing.count += 1;
        if (line.timestamp) existing.lastAt = line.timestamp;
      } else {
        const ctxText = compactContext(ctx);
        errors.set(key, {
          key,
          level: line.level,
          count: 1,
          sample: truncate(ctxText ? `${text} {${ctxText}}` : text, 300),
          firstAt: line.timestamp,
          lastAt: line.timestamp
        });
      }
      if (!categorized) digest.signalEvents += line.level === "error" ? 1 : 0;
    }
  }
  digest.errors = [...errors.values()].sort((a, b) => b.count - a.count);
  digest.trades.estimatedPlaced = Math.max(0, digest.trades.riskPassed - digest.trades.executionFailed);
  return digest;
}

function topEntries(record: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function fmtCounts(record: Record<string, number>, limit: number): string {
  const entries = topEntries(record, limit);
  if (entries.length === 0) return "-";
  const rest = Object.keys(record).length - entries.length;
  return entries.map(([key, count]) => `${truncate(key, 60)}=${count}`).join(", ") + (rest > 0 ? `, (+${rest} more)` : "");
}

function symbolLine(symbol: string, funnel: SymbolFunnel, limit: number): string {
  const stages = FUNNEL_ORDER.filter((stage) => funnel.stages[stage])
    .map((stage) => `${stage}=${funnel.stages[stage]}`)
    .join(" > ");
  const extras: string[] = [];
  if (Object.keys(funnel.planRejectReasons).length) extras.push(`planReject[${fmtCounts(funnel.planRejectReasons, limit)}]`);
  if (Object.keys(funnel.riskRejectReasons).length) extras.push(`riskReject[${fmtCounts(funnel.riskRejectReasons, limit)}]`);
  if (Object.keys(funnel.archiveReasons).length) extras.push(`archived[${fmtCounts(funnel.archiveReasons, limit)}]`);
  return `- ${symbol}: ${stages || "(no ordered stages)"}${extras.length ? ` | ${extras.join(" ")}` : ""}`;
}

/** Drop-off between key stages: where setups that met conditions stopped. */
export function funnelDropoffs(totals: Record<string, number>): string[] {
  const pairs: Array<[string, string]> = [
    ["HTF_FIRST_TOUCH_CONFIRMED", "LTF_FIRST_TOUCH_CONFIRMED"],
    ["LTF_FIRST_TOUCH_CONFIRMED", "ENTRY_PLAN_CREATED"],
    ["ENTRY_PLAN_CREATED", "RISK_MANAGER_REACHED"],
    ["RISK_MANAGER_REACHED", "RISK_PASSED"]
  ];
  const out: string[] = [];
  for (const [from, to] of pairs) {
    const a = totals[from] ?? 0;
    const b = totals[to] ?? 0;
    if (a > 0) out.push(`${from}(${a}) -> ${to}(${b}): ratio ${Math.round((b / a) * 100)}%`);
  }
  return out;
}

function renderWithLimit(d: Digest, limit: number, sampleChars: number): string {
  const lines: string[] = [];
  lines.push(`## Log digest`);
  lines.push(`window: ${d.window.from ?? "?"} .. ${d.window.to ?? "?"} | lines=${d.totalLines} formats[${fmtCounts(d.parsedByFormat, 3)}] levels[${fmtCounts(d.levels, 5)}]`);
  lines.push(
    `trades: riskPassed=${d.trades.riskPassed} executionFailed=${d.trades.executionFailed} estimatedPlaced=${d.trades.estimatedPlaced} confirmations=${d.trades.confirmations}`
  );
  lines.push(`entryRejected(reason): ${fmtCounts(d.entryRejected, limit)}`);
  lines.push(`planRejectedBeforeRisk(reason): ${fmtCounts(d.planRejected, limit)} | classification: ${fmtCounts(d.planRejectedClassification, 3)}`);
  lines.push(`candidateArchived(reason): ${fmtCounts(d.archiveReasons, limit)}`);
  lines.push(`executionSubmissionFailed(code): ${fmtCounts(d.executionFailures, limit)}`);
  lines.push(`runtimeFailures: ${fmtCounts(d.runtimeFailures, limit)} | scannerScanFailed=${d.scannerFailures} | protectionIssues=${d.protectionIssues}${d.stackFrames ? ` | stackFrames=${d.stackFrames}` : ""}`);
  lines.push(`funnelTotals: ${FUNNEL_ORDER.filter((s) => d.funnelTotals[s]).map((s) => `${s}=${d.funnelTotals[s]}`).join(", ") || "-"}`);
  const drops = funnelDropoffs(d.funnelTotals);
  if (drops.length) lines.push(`dropoffs: ${drops.join("; ")}`);
  const symbols = Object.entries(d.funnelBySymbol).sort(
    (a, b) => Object.values(b[1].stages).reduce((x, y) => x + y, 0) - Object.values(a[1].stages).reduce((x, y) => x + y, 0)
  );
  if (symbols.length) {
    lines.push(`funnelBySymbol (top ${Math.min(limit, symbols.length)} of ${symbols.length}):`);
    for (const [symbol, funnel] of symbols.slice(0, limit)) lines.push(symbolLine(symbol, funnel, Math.max(2, Math.floor(limit / 2))));
  }
  if (d.errors.length) {
    lines.push(`errors/warnings (deduped, top ${Math.min(limit, d.errors.length)} of ${d.errors.length}):`);
    for (const sample of d.errors.slice(0, limit)) {
      lines.push(`- [${sample.level} x${sample.count}] ${truncate(sample.sample, sampleChars)} (first=${sample.firstAt ?? "?"} last=${sample.lastAt ?? "?"})`);
    }
  }
  return lines.join("\n");
}

/** Renders the digest as compact text within `maxChars`, progressively shrinking lists. */
export function renderDigest(d: Digest, maxChars: number): string {
  for (const [limit, sampleChars] of [
    [20, 300],
    [12, 220],
    [8, 160],
    [5, 120],
    [3, 100],
    [1, 80]
  ] as const) {
    const text = renderWithLimit(d, limit, sampleChars);
    if (text.length <= maxChars) return text;
  }
  const text = renderWithLimit(d, 1, 60);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 20)}\n…[digest truncated]`;
}

/** One-line summary used in memory and PR bodies. */
export function summarizeDigest(d: Digest): string {
  const top = (record: Record<string, number>) => topEntries(record, 3).map(([k, v]) => `${k}=${v}`).join(",") || "-";
  return `lines=${d.totalLines} window=${d.window.from ?? "?"}..${d.window.to ?? "?"} placed~${d.trades.estimatedPlaced} entryRejected[${top(d.entryRejected)}] planRejected[${top(d.planRejected)}] archived[${top(d.archiveReasons)}] execFailed=${d.trades.executionFailed} errors=${d.errors.length}`;
}
