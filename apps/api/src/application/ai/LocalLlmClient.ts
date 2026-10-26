import { DEFAULT_AI_MIN_CALL_INTERVAL_MS } from "./AiCallGate.js";

export interface LlmChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmChatRequest {
  model: string;
  messages: LlmChatMessage[];
  /** Ask the server for a JSON object (OpenAI `response_format: json_object`). */
  jsonMode?: boolean;
  temperature?: number;
}

export interface LlmChatResponse {
  /** Model id reported by the server, or the requested one when the server omits it. */
  model: string;
  content: string;
}

/** Port used by the AI advisor; tests inject a fake. */
export interface LlmClient {
  complete(request: LlmChatRequest): Promise<LlmChatResponse>;
}

export interface LlmStreamOptions {
  /** Overall limit for the whole answer; defaults to the client's timeoutMs. */
  timeoutMs?: number;
  /** Aborts the request (e.g. the browser closed the chat). */
  signal?: AbortSignal;
}

/** Chat port: the answer arrives in pieces through onDelta and is also returned whole. */
export interface StreamingLlmClient {
  stream(request: LlmChatRequest, onDelta: (text: string) => void, options?: LlmStreamOptions): Promise<LlmChatResponse>;
}

export interface LocalLlmConfig {
  baseUrl: string;
  apiKey: string | null;
  defaultModel: string;
  timeoutMs: number;
  /** Chat answers are longer than trade decisions, so they get their own limit. */
  chatTimeoutMs: number;
  /** Minimum gap between AI advisor model calls across all accounts (chat is limited per user instead). */
  minCallIntervalMs: number;
}

export const DEFAULT_AI_BASE_URL = "http://localhost:20128/v1";
export const DEFAULT_AI_MODEL = "cx/gpt-5.6-sol";
export const DEFAULT_AI_TIMEOUT_MS = 20_000;
export const DEFAULT_AI_CHAT_TIMEOUT_MS = 120_000;

/** Process-level LLM settings. Secrets live in env only, never in account settings. */
export function loadLocalLlmConfig(env: NodeJS.ProcessEnv = process.env): LocalLlmConfig {
  const timeout = Number(env.AI_TIMEOUT_MS);
  const chatTimeout = Number(env.AI_CHAT_TIMEOUT_MS);
  const minInterval = env.AI_MIN_CALL_INTERVAL_MS?.trim() ? Number(env.AI_MIN_CALL_INTERVAL_MS) : Number.NaN;
  return {
    baseUrl: (env.AI_BASE_URL?.trim() || DEFAULT_AI_BASE_URL).replace(/\/+$/, ""),
    apiKey: env.AI_API_KEY?.trim() || null,
    defaultModel: env.AI_MODEL?.trim() || DEFAULT_AI_MODEL,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : DEFAULT_AI_TIMEOUT_MS,
    chatTimeoutMs: Number.isFinite(chatTimeout) && chatTimeout > 0 ? Math.floor(chatTimeout) : DEFAULT_AI_CHAT_TIMEOUT_MS,
    // 0 turns the spacing off; anything unparseable keeps the default.
    minCallIntervalMs: Number.isFinite(minInterval) && minInterval >= 0 ? Math.floor(minInterval) : DEFAULT_AI_MIN_CALL_INTERVAL_MS
  };
}

export class LlmRequestError extends Error {
  constructor(
    readonly code: "LLM_TIMEOUT" | "LLM_HTTP_ERROR" | "LLM_NETWORK_ERROR" | "LLM_EMPTY_RESPONSE" | "LLM_ABORTED",
    message: string
  ) {
    super(message);
    this.name = "LlmRequestError";
  }
}

/** Minimal OpenAI-compatible `/chat/completions` client built on fetch. */
export class LocalLlmClient implements LlmClient, StreamingLlmClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: Pick<LocalLlmConfig, "baseUrl" | "apiKey" | "timeoutMs">,
    fetchImpl?: typeof fetch
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async complete(request: LlmChatRequest): Promise<LlmChatResponse> {
    const deadline = Date.now() + this.config.timeoutMs;
    try {
      return await this.post(request, request.jsonMode === true, deadline);
    } catch (error) {
      // Some local servers reject `response_format`; retry once without it inside the same deadline.
      if (request.jsonMode && error instanceof LlmRequestError && error.code === "LLM_HTTP_ERROR" && /\b400\b/.test(error.message)) {
        return this.post(request, false, deadline);
      }
      throw error;
    }
  }

  private async post(request: LlmChatRequest, jsonMode: boolean, deadline: number): Promise<LlmChatResponse> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new LlmRequestError("LLM_TIMEOUT", `LLM request timed out after ${this.config.timeoutMs}ms`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
      stream: false
    };
    if (jsonMode) body.response_format = { type: "json_object" };

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) throw new LlmRequestError("LLM_TIMEOUT", `LLM request timed out after ${this.config.timeoutMs}ms`);
      throw new LlmRequestError("LLM_NETWORK_ERROR", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw new LlmRequestError("LLM_HTTP_ERROR", `LLM HTTP ${response.status}: ${text.slice(0, 300)}`);
    const parsed = safeJsonParse(text) as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> } | null;
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) throw new LlmRequestError("LLM_EMPTY_RESPONSE", "LLM response has no message content");
    return { model: typeof parsed?.model === "string" && parsed.model ? parsed.model : request.model, content };
  }

  /**
   * `stream: true` request; reads the server-sent `data:` chunks and forwards each content delta.
   * A server that ignores `stream` and answers with one JSON body still works (one delta).
   */
  async stream(request: LlmChatRequest, onDelta: (text: string) => void, options: LlmStreamOptions = {}): Promise<LlmChatResponse> {
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromCaller = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    const failure = (error: unknown): LlmRequestError => {
      if (error instanceof LlmRequestError) return error;
      if (timedOut) return new LlmRequestError("LLM_TIMEOUT", `LLM request timed out after ${timeoutMs}ms`);
      if (controller.signal.aborted) return new LlmRequestError("LLM_ABORTED", "LLM request was cancelled");
      return new LlmRequestError("LLM_NETWORK_ERROR", error instanceof Error ? error.message : String(error));
    };

    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: request.model, messages: request.messages, temperature: request.temperature ?? 0.3, stream: true }),
        signal: controller.signal
      });
      if (!response.ok) throw new LlmRequestError("LLM_HTTP_ERROR", `LLM HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);

      let model = request.model;
      let content = "";
      if (!(response.headers.get("content-type") ?? "").includes("text/event-stream") || !response.body) {
        const parsed = safeJsonParse(await response.text()) as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> } | null;
        const whole = parsed?.choices?.[0]?.message?.content;
        if (typeof parsed?.model === "string" && parsed.model) model = parsed.model;
        if (typeof whole === "string" && whole.length > 0) {
          content = whole;
          onDelta(whole);
        }
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let done = false;
        while (!done) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              done = true;
              break;
            }
            const parsed = safeJsonParse(data) as { model?: unknown; choices?: Array<{ delta?: { content?: unknown } }> } | null;
            if (typeof parsed?.model === "string" && parsed.model) model = parsed.model;
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              content += delta;
              onDelta(delta);
            }
          }
        }
        if (done) await reader.cancel().catch(() => undefined);
      }
      if (content.trim().length === 0) throw new LlmRequestError("LLM_EMPTY_RESPONSE", "LLM response has no message content");
      return { model, content };
    } catch (error) {
      throw failure(error);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

/**
 * Extracts the first JSON object from model output. Tolerates reasoning blocks, markdown fences
 * and prose around the object. Returns null when no parseable object exists.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const direct = safeJsonParse(cleaned);
  if (isPlainObject(direct)) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  if (fenced?.[1]) {
    const inner = safeJsonParse(fenced[1].trim());
    if (isPlainObject(inner)) return inner;
  }

  for (let start = cleaned.indexOf("{"); start !== -1; start = cleaned.indexOf("{", start + 1)) {
    const end = matchingBrace(cleaned, start);
    if (end === -1) continue;
    const candidate = safeJsonParse(cleaned.slice(start, end + 1));
    if (isPlainObject(candidate)) return candidate;
  }
  return null;
}

function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
