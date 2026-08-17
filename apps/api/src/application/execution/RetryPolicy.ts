export interface RetryPolicyOptions {
  maxAttempts: number;
  baseDelayMs: number;
}

export async function withRetry<T>(operation: () => Promise<T>, options: RetryPolicyOptions, shouldRetry: (error: unknown) => boolean): Promise<T> {
  let lastError: unknown;
  const attempts = Math.max(1, options.maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) break;
      await sleep(backoffDelay(options.baseDelayMs, attempt));
    }
  }
  throw lastError;
}

export function backoffDelay(baseDelayMs: number, attempt: number): number {
  const base = Math.max(0, baseDelayMs);
  const jitter = Math.floor(Math.random() * Math.max(1, base));
  return base * 2 ** Math.max(0, attempt - 1) + jitter;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
