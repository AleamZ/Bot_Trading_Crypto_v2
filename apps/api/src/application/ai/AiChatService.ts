import { z } from "zod";
import { BOT_ANALYSIS_RULES } from "./BotAnalysisSkill.js";
import type { LlmChatMessage, StreamingLlmClient } from "./LocalLlmClient.js";

export interface AiChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Turns kept from the browser history; older ones are dropped before calling the model. */
export const AI_CHAT_MAX_TURNS = 16;
export const AI_CHAT_MAX_CHARS = 4_000;
/** Symbols analysed per question, to keep the context small. */
export const AI_CHAT_MAX_SYMBOLS = 3;

export class InvalidAiChatInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAiChatInputError";
  }
}

const chatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(AI_CHAT_MAX_CHARS)
      })
    )
    .min(1)
    .max(60)
});

/** Validates the request body and keeps the most recent turns, which must end with the user's question. */
export function parseAiChatTurns(body: unknown): AiChatTurn[] {
  const parsed = chatBodySchema.safeParse(body);
  if (!parsed.success) throw new InvalidAiChatInputError(`Chat messages must be 1-60 turns of 1-${AI_CHAT_MAX_CHARS} characters`);
  const turns = parsed.data.messages.slice(-AI_CHAT_MAX_TURNS);
  if (turns.at(-1)?.role !== "user") throw new InvalidAiChatInputError("The last chat message must be the user's question");
  return turns;
}

/**
 * Symbols the question is about: explicit `XXXUSDT` tickers first, then watchlist symbols named by
 * their base asset ("btc", "ETH"). At most AI_CHAT_MAX_SYMBOLS, in order of appearance.
 */
export function mentionedSymbols(text: string, watchlist: readonly string[]): string[] {
  const found: string[] = [];
  const add = (symbol: string) => {
    if (!found.includes(symbol) && found.length < AI_CHAT_MAX_SYMBOLS) found.push(symbol);
  };
  for (const match of text.matchAll(/\b([a-z0-9]{2,20}usdt)\b/gi)) add(match[1]!.toUpperCase());
  const words = new Set(text.toUpperCase().match(/[A-Z0-9]+/g) ?? []);
  for (const symbol of watchlist) {
    const base = symbol.replace(/USDT$/, "");
    if (base.length >= 2 && words.has(base)) add(symbol);
  }
  return found;
}

/**
 * Read-only facts about the account the assistant may use. Built by the HTTP layer from runtime
 * state; it must never contain credentials (only whitelisted fields are copied in).
 */
export interface AiChatContext {
  now: string;
  account: { name: string; mode: "DEMO" | "REAL" };
  settings: Record<string, unknown> | null;
  runtime: Record<string, unknown> | null;
  watchlist: unknown[];
  recentEvents: unknown[];
  aiDecisions: unknown[];
  aiSteps: unknown[];
  positions: unknown[] | null;
  openOrders: unknown[] | null;
  symbols: Array<{ symbol: string; inWatchlist: boolean; analysis: unknown; candles: unknown }>;
  /** Parts that could not be loaded, so the model says so instead of guessing. */
  unavailable: string[];
}

let systemPrompt: string | null = null;

/**
 * Built on first use, not at import: BotAnalysisSkill imports Server.ts, which imports this module,
 * so BOT_ANALYSIS_RULES is not initialised yet while this file is first evaluated.
 */
export function aiChatSystemPrompt(): string {
  systemPrompt ??= buildSystemPrompt();
  return systemPrompt;
}

const buildSystemPrompt = (): string => [
  "Bạn là trợ lý AI trong dashboard của SMC Futures Bot: bot giao dịch Binance USDT-M Futures theo Smart Money Concepts, do chính người dùng vận hành.",
  "Quy tắc trả lời:",
  "- Trả lời bằng tiếng Việt, ngắn gọn, có cấu trúc (gạch đầu dòng khi liệt kê). Dùng **in đậm** cho điểm chính.",
  "- Chỉ dùng số liệu trong CONTEXT (JSON) và lịch sử chat. Nếu thiếu dữ liệu (xem `unavailable`), nói rõ là không có, không bịa số.",
  "- Nêu thời điểm của dữ liệu khi dùng giá hoặc trạng thái (CONTEXT.now, lastScanAt, checkedAt).",
  "- Bạn CHỈ ĐỌC: không thể đặt/huỷ lệnh, không đổi setting, không bật/tắt bot. Nếu người dùng yêu cầu, nói rõ họ cần tự làm (tab Setting hoặc Binance) và có thể hướng dẫn cách làm.",
  "- Phân tích theo đúng luật chiến lược của bot bên dưới; khi nói về một symbol, dựa vào `symbols[].analysis` (giống tab Analysis) và nến `symbols[].candles`.",
  "- Đây là phân tích kỹ thuật để tham khảo, không phải lời khuyên tài chính; không hứa hẹn lợi nhuận.",
  "- Giải thích thuật ngữ khi cần: FVG, BOS, CHOCH, BSL/SSL, R/R, 1R, ADVISORY/AUTO.",
  "",
  "Luật chiến lược (7 điều kiện, theo thứ tự):",
  ...BOT_ANALYSIS_RULES.map((rule, index) => `${index + 1}. ${rule.title}: ${rule.rule}`),
  "",
  "Chế độ AI giao dịch: OFF = AI không làm gì; ADVISORY = AI chỉ ghi lại quyết định; AUTO = AI được đặt lệnh trên tài khoản DEMO, vẫn qua risk manager, kill switch và giới hạn vị thế."
].join("\n");

export function buildAiChatMessages(context: AiChatContext, turns: readonly AiChatTurn[]): LlmChatMessage[] {
  return [
    { role: "system", content: aiChatSystemPrompt() },
    { role: "system", content: `CONTEXT (JSON, read-only, generated ${context.now}):\n${JSON.stringify(context)}` },
    ...turns.map((turn) => ({ role: turn.role, content: turn.content }))
  ];
}

export interface AiChatServiceOptions {
  llm: StreamingLlmClient;
  defaultModel: string;
  timeoutMs: number;
  now?: () => number;
}

/** Answers dashboard questions with the local LLM. Read-only: it only ever produces text. */
export class AiChatService {
  private readonly now: () => number;

  constructor(private readonly options: AiChatServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  modelFor(accountModel: string | null | undefined): string {
    return accountModel?.trim() || this.options.defaultModel;
  }

  async reply(params: {
    context: AiChatContext;
    turns: readonly AiChatTurn[];
    model: string;
    onDelta: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<{ model: string; content: string; latencyMs: number }> {
    const startedAt = this.now();
    const response = await this.options.llm.stream(
      { model: params.model, messages: buildAiChatMessages(params.context, params.turns), temperature: 0.3 },
      params.onDelta,
      { timeoutMs: this.options.timeoutMs, ...(params.signal ? { signal: params.signal } : {}) }
    );
    return { model: response.model, content: response.content, latencyMs: this.now() - startedAt };
  }
}
