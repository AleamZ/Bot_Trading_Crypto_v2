import type { DecisionLogger } from "../../application/ports/Logger.js";

export class ConsoleDecisionLogger implements DecisionLogger {
  info(message: string, context?: Record<string, unknown>): void {
    console.info(formatLog("info", message, context));
  }

  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(formatLog("warn", message, context));
  }

  error(message: string, context?: Record<string, unknown>): void {
    console.error(formatLog("error", message, context));
  }
}

function formatLog(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): string {
  const at = new Date().toISOString();
  if (process.env.NODE_ENV === "production") {
    return JSON.stringify({
      timestamp: at,
      level,
      component: "api",
      message,
      ...sanitizeContext(context)
    });
  }
  const reason = getReason(context);
  return reason ? `[${at}] ${level.toUpperCase()} ${message}: ${reason}` : `[${at}] ${level.toUpperCase()} ${message}`;
}

function getReason(context?: Record<string, unknown>): string | null {
  if (!context) return null;
  const event = context.event;
  if (isRecord(event) && typeof event.reason === "string") return event.reason;
  const error = context.error;
  if (typeof error === "string") return error;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeContext(context?: Record<string, unknown>): Record<string, unknown> {
  if (!context) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (/secret|token|password|credential|apiKey|apiSecret/i.test(key)) {
      output[key] = "configured";
    } else if (value instanceof Error) {
      output[key] = value.message;
    } else {
      output[key] = value;
    }
  }
  return output;
}
