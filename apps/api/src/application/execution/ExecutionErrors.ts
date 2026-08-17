export type ExecutionErrorCode =
  | "AUTH_ERROR"
  | "INVALID_ORDER"
  | "INSUFFICIENT_MARGIN"
  | "RATE_LIMITED"
  | "BINANCE_UNAVAILABLE"
  | "NETWORK_TIMEOUT"
  | "ORDER_NOT_FOUND"
  | "DUPLICATE_REQUEST"
  | "RECONCILIATION_REQUIRED"
  | "REAL_EXECUTION_LOCKED"
  | "BINANCE_TIME_SYNC_ERROR"
  | "PERSISTENCE_UNAVAILABLE";

export interface ClassifiedExecutionError {
  code: ExecutionErrorCode;
  retryable: boolean;
  ambiguous: boolean;
  message: string;
}

export function classifyExecutionError(error: unknown): ClassifiedExecutionError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (message.includes("REAL_EXECUTION_LOCKED")) return { code: "REAL_EXECUTION_LOCKED", retryable: false, ambiguous: false, message };
  if (lower.includes("timestamp") || lower.includes("-1021")) return { code: "BINANCE_TIME_SYNC_ERROR", retryable: false, ambiguous: true, message };
  if (lower.includes("rate") || lower.includes("429") || lower.includes("418")) return { code: "RATE_LIMITED", retryable: true, ambiguous: true, message };
  if (lower.includes("timeout") || lower.includes("econnreset") || lower.includes("network")) return { code: "NETWORK_TIMEOUT", retryable: true, ambiguous: true, message };
  if (lower.includes("502") || lower.includes("503") || lower.includes("504") || lower.includes("unavailable")) return { code: "BINANCE_UNAVAILABLE", retryable: true, ambiguous: true, message };
  if (lower.includes("insufficient")) return { code: "INSUFFICIENT_MARGIN", retryable: false, ambiguous: false, message };
  if (lower.includes("invalid") || lower.includes("400")) return { code: "INVALID_ORDER", retryable: false, ambiguous: false, message };
  if (lower.includes("auth") || lower.includes("401") || lower.includes("403")) return { code: "AUTH_ERROR", retryable: false, ambiguous: false, message };
  if (lower.includes("duplicate")) return { code: "DUPLICATE_REQUEST", retryable: false, ambiguous: true, message };
  return { code: "BINANCE_UNAVAILABLE", retryable: false, ambiguous: true, message };
}
