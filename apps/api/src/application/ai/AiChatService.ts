import { z } from "zod";
import { BOT_ANALYSIS_RULES } from "./BotAnalysisSkill.js";
import type { ChatOrderProposalResult, ChatOrderRequest } from "./AiChatOrders.js";
import { LlmRequestError, type LlmAgentMessage, type LlmChatMessage, type LlmToolCall, type LlmToolDefinition, type StreamingLlmClient, type ToolCallingLlmClient } from "./LocalLlmClient.js";

export interface AiChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Turns kept from the browser history; older ones are dropped before calling the model. */
export const AI_CHAT_MAX_TURNS = 16;
export const AI_CHAT_MAX_CHARS = 4_000;
/** Symbols analysed per question, to keep the context small. */
export const AI_CHAT_MAX_SYMBOLS = 3;
/** Tool rounds per answer before the model must reply in text. */
export const AI_CHAT_MAX_TOOL_ROUNDS = 5;
/** A tool result longer than this is cut before it goes back to the model. */
export const AI_CHAT_TOOL_RESULT_MAX_CHARS = 16_000;
/** Majors recognised by name even when they are not in the watchlist. */
const MAJOR_ASSETS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX", "TRX", "LTC"];

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
  for (const base of MAJOR_ASSETS) {
    if (words.has(base)) add(`${base}USDT`);
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
  "Bạn là trợ lý giao dịch AI trong dashboard của SMC Futures Bot: bot giao dịch Binance USDT-M Futures theo Smart Money Concepts, do chính người dùng vận hành.",
  "Bạn làm được: phân tích và suy luận về thị trường, đưa nhận định và lời khuyên cụ thể, đọc tin tức crypto mới nhất, và đề xuất lệnh để người dùng xác nhận đặt trên tài khoản DEMO.",
  "",
  "Cách trả lời:",
  "- Tiếng Việt, có cấu trúc, gạch đầu dòng khi liệt kê, **in đậm** điểm chính. Đi thẳng vào kết luận, rồi lý do.",
  "- Chỉ dùng số liệu trong CONTEXT (JSON), kết quả công cụ và lịch sử chat. Thiếu dữ liệu thì gọi công cụ; công cụ lỗi thì nói rõ, không bịa số hay bịa tin.",
  "- Nêu thời điểm của dữ liệu khi dùng giá hoặc tin (CONTEXT.now, fetchedAt, publishedAt).",
  "- Kết thúc bằng một dòng ngắn: đây là phân tích tham khảo, người dùng tự chịu trách nhiệm khi giao dịch.",
  "",
  "Phân tích một coin (suy luận từng bước):",
  "- Nếu CONTEXT.symbols chưa có coin đó, gọi get_market_analysis (dùng được cho mọi symbol USDT-M, không chỉ watchlist).",
  "- Đi lần lượt: xu hướng H1 (EMA), cấu trúc (BOS/CHOCH, swing), vùng FVG còn hiệu lực, thanh khoản BSL/SSL, vị trí giá hiện tại, setup của bot đang ở bước nào.",
  "- Kết luận: thiên hướng (tăng/giảm/đi ngang) và mức tự tin, kịch bản chính và kịch bản phụ, vùng vào lệnh, SL, TP, R:R, điều kiện làm kịch bản sai.",
  "- Khi người dùng hỏi nên làm gì, đưa lời khuyên rõ ràng (vào/chờ/đứng ngoài) kèm lý do, không né tránh.",
  "",
  "Tin tức:",
  "- Gọi get_crypto_news khi người dùng hỏi tin, sự kiện, hoặc khi tin có thể đổi nhận định. Tóm tắt các tin chính kèm nguồn, thời gian và link; đánh giá tác động lên giá (tích cực/tiêu cực/trung tính) và mức chắc chắn.",
  "",
  "Đặt lệnh (chỉ khi người dùng yêu cầu rõ ràng):",
  "- Gọi get_market_analysis trước để có giá live và cấu trúc, rồi gọi propose_order. Lệnh vào là MARKET tại giá hiện tại.",
  "- SL đặt sau cấu trúc gần nhất (swing hoặc FVG bảo vệ), TP tại thanh khoản hoặc mục tiêu với R:R ≥ settings.minimumRiskReward. LONG: SL < giá < TP. SHORT: TP < giá < SL. Người dùng đưa SL/TP thì dùng đúng số đó.",
  "- Người dùng bảo đặt lệnh (kể cả lệnh thử) mà không đưa chiều hay SL/TP: tự chọn chiều theo xu hướng H1 (hoặc theo nến gần nhất nếu chưa rõ), SL sau swing high/low gần nhất của nến M5/H1, TP theo R:R tối thiểu, rồi gọi propose_order. Không từ chối chỉ vì setup của bot chưa đủ điều kiện; nói rõ đây là lệnh ngoài setup của bot.",
  "- Khối lượng: người dùng nói số coin (vd 0.01 BTC) thì truyền quantity đúng số đó; nói theo USDT (vd 100 USDT) thì quantity = USDT / giá hiện tại; không nói thì để quantity = null để bot tính theo riskPerTradeUsdt.",
  "- propose_order KHÔNG đặt lệnh: nó chạy risk manager và hiện một thẻ lệnh có nút xác nhận. Sau khi gọi thành công, tóm tắt thông số trong thẻ và nhắc người dùng bấm **Xác nhận đặt lệnh** trên thẻ. Không bao giờ nói là lệnh đã được đặt.",
  "- Giá vào là giá live lúc đề xuất và lúc xác nhận, nên chọn TP cho R:R cao hơn minimumRiskReward ít nhất 0,3 để giá nhích không làm lệnh bị từ chối.",
  "- propose_order bị từ chối vì R:R hoặc vị trí SL/TP thì tự chỉnh theo giá live trong lý do từ chối và gọi lại (tối đa 2 lần). Lý do khác (kill switch, margin, số dư, REAL...) thì giải thích và gợi ý cách sửa (đổi khối lượng, setting).",
  "- Chỉ tài khoản DEMO đặt được lệnh; REAL bị khoá. Bạn không huỷ lệnh, không đóng vị thế, không đổi setting: hướng dẫn người dùng tự làm trên dashboard hoặc Binance.",
  "",
  "Thuật ngữ cần giải thích khi dùng: FVG, BOS, CHOCH, BSL/SSL, R/R, 1R, ADVISORY/AUTO.",
  "",
  "Luật chiến lược của bot (7 điều kiện, theo thứ tự):",
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

/** What the chat tools can reach, bound to one account and user by the HTTP layer. */
export interface AiChatToolbox {
  marketAnalysis(symbol: string): Promise<unknown>;
  news(params: { coin: string | null; keywords: string[]; limit: number }): Promise<unknown>;
  /** Runs the risk manager and stores a card for the user to confirm; never places an order. */
  proposeOrder(request: ChatOrderRequest): Promise<ChatOrderProposalResult>;
}

/** Progress shown in the chat while the model works. */
export interface AiChatToolEvent {
  id: string;
  name: string;
  status: "start" | "done" | "error";
  label: string;
  detail?: string;
}

export const AI_CHAT_TOOLS: LlmToolDefinition[] = [
  {
    name: "get_market_analysis",
    description:
      "Bot's SMC analysis for one Binance USDT-M symbol (same as the Analysis tab): trend, setup state, FVGs, liquidity, entry plan, plus the live price and recent closed H1/M5 candles. Works for any USDT-M symbol, not only the watchlist.",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string", description: "e.g. BTCUSDT (BTC also works)" } },
      required: ["symbol"],
      additionalProperties: false
    }
  },
  {
    name: "get_crypto_news",
    description:
      "Latest crypto news headlines (Cointelegraph, CoinDesk, Decrypt RSS), newest first, with source, time, link and a short summary. Filter by coin and/or keywords; no filter = general market news.",
    parameters: {
      type: "object",
      properties: {
        coin: { type: ["string", "null"], description: "Base asset, e.g. BTC, ETH; null for general news" },
        keywords: { type: "array", items: { type: "string" }, description: "Extra English keywords, e.g. ['etf', 'sec']" },
        limit: { type: "integer", minimum: 1, maximum: 15 }
      },
      additionalProperties: false
    }
  },
  {
    name: "propose_order",
    description:
      "Prepares a MARKET order with stop loss and take profit for the user to confirm on a card in the chat. It runs the bot's risk manager (sizing, margin, leverage, R:R, kill switch) and does NOT place the order. Only when the user explicitly asks to open a trade.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "e.g. BTCUSDT" },
        side: { type: "string", enum: ["LONG", "SHORT"] },
        stopLoss: { type: "number" },
        takeProfit: { type: "number" },
        quantity: { type: ["number", "null"], description: "Coins (base asset), e.g. 0.01 for BTC; null = size from the account's riskPerTradeUsdt" },
        reason: { type: "string", description: "Short rationale shown on the card" }
      },
      required: ["symbol", "side", "stopLoss", "takeProfit", "quantity", "reason"],
      additionalProperties: false
    }
  }
];

const analysisArgs = z.object({ symbol: z.string().trim().min(2).max(24) });
const newsArgs = z.object({
  coin: z.string().trim().max(20).nullish(),
  keywords: z.array(z.string().trim().max(40)).max(8).nullish(),
  limit: z.number().int().min(1).max(15).nullish()
});
const orderArgs = z.object({
  symbol: z.string().trim().min(2).max(24),
  side: z.string().trim().transform((value) => value.toUpperCase()).pipe(z.enum(["LONG", "SHORT"])),
  stopLoss: z.coerce.number().positive(),
  takeProfit: z.coerce.number().positive(),
  quantity: z.coerce.number().positive().nullish(),
  reason: z.string().trim().max(500).nullish()
});

export interface AiChatServiceOptions {
  llm: StreamingLlmClient | (StreamingLlmClient & ToolCallingLlmClient);
  defaultModel: string;
  timeoutMs: number;
  now?: () => number;
}

export interface AiChatReplyParams {
  context: AiChatContext;
  turns: readonly AiChatTurn[];
  model: string;
  onDelta: (text: string) => void;
  signal?: AbortSignal;
  /** Without a toolbox (or a tool-calling model) the answer uses the context alone. */
  tools?: AiChatToolbox;
  onTool?: (event: AiChatToolEvent) => void;
}

/**
 * Answers dashboard questions with the local LLM. With a toolbox and a tool-calling model it can
 * look up any symbol, read news and propose orders; otherwise it answers from the context alone.
 */
export class AiChatService {
  private readonly now: () => number;

  constructor(private readonly options: AiChatServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  modelFor(accountModel: string | null | undefined): string {
    return accountModel?.trim() || this.options.defaultModel;
  }

  async reply(params: AiChatReplyParams): Promise<{ model: string; content: string; latencyMs: number }> {
    const startedAt = this.now();
    const llm = this.options.llm;
    if (params.tools && "completeWithTools" in llm) {
      const answer = await this.replyWithTools(llm, params, params.tools, startedAt);
      if (answer) return { ...answer, latencyMs: this.now() - startedAt };
    }
    const response = await llm.stream(
      { model: params.model, messages: buildAiChatMessages(params.context, params.turns), temperature: 0.3 },
      params.onDelta,
      { timeoutMs: this.remaining(startedAt), ...(params.signal ? { signal: params.signal } : {}) }
    );
    return { model: response.model, content: response.content, latencyMs: this.now() - startedAt };
  }

  /** Tool-calling loop; null when the server rejects `tools` on the first round (plain answer instead). */
  private async replyWithTools(llm: ToolCallingLlmClient, params: AiChatReplyParams, tools: AiChatToolbox, startedAt: number): Promise<{ model: string; content: string } | null> {
    const messages: LlmAgentMessage[] = buildAiChatMessages(params.context, params.turns);
    for (let round = 0; ; round += 1) {
      const lastRound = round >= AI_CHAT_MAX_TOOL_ROUNDS;
      let response;
      try {
        response = await llm.completeWithTools(
          { model: params.model, messages, tools: lastRound ? [] : AI_CHAT_TOOLS, temperature: 0.3 },
          { timeoutMs: this.remaining(startedAt), ...(params.signal ? { signal: params.signal } : {}) }
        );
      } catch (error) {
        if (round === 0 && error instanceof LlmRequestError && error.code === "LLM_HTTP_ERROR" && /\b(400|404|422)\b/.test(error.message)) return null;
        throw error;
      }
      if (response.toolCalls.length === 0 || lastRound) {
        if (!response.content.trim()) throw new LlmRequestError("LLM_EMPTY_RESPONSE", "LLM response has no message content");
        params.onDelta(response.content);
        return { model: response.model, content: response.content };
      }
      messages.push({ role: "assistant", content: response.content || null, toolCalls: response.toolCalls });
      for (const call of response.toolCalls) {
        messages.push({ role: "tool", toolCallId: call.id, content: await this.runTool(call, tools, params.onTool) });
      }
    }
  }

  private async runTool(call: LlmToolCall, tools: AiChatToolbox, onTool: ((event: AiChatToolEvent) => void) | undefined): Promise<string> {
    let args: unknown;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      return toolResult({ ok: false, error: "INVALID_ARGUMENTS", message: "Arguments are not valid JSON" });
    }
    const emit = (status: AiChatToolEvent["status"], label: string, detail?: string) => onTool?.({ id: call.id, name: call.name, status, label, ...(detail ? { detail } : {}) });
    try {
      if (call.name === "get_market_analysis") {
        const parsed = analysisArgs.safeParse(args);
        if (!parsed.success) return toolResult({ ok: false, error: "INVALID_ARGUMENTS", message: parsed.error.message });
        const symbol = toUsdtSymbol(parsed.data.symbol);
        emit("start", `Đang xem phân tích ${symbol}`);
        const result = await tools.marketAnalysis(symbol);
        emit("done", `Đã xem phân tích ${symbol}`);
        return toolResult(result);
      }
      if (call.name === "get_crypto_news") {
        const parsed = newsArgs.safeParse(args);
        if (!parsed.success) return toolResult({ ok: false, error: "INVALID_ARGUMENTS", message: parsed.error.message });
        const coin = parsed.data.coin?.trim() ? parsed.data.coin.trim().toUpperCase().replace(/USDT$/, "") : null;
        const topic = coin ?? "thị trường";
        emit("start", `Đang đọc tin ${topic}`);
        const result = await tools.news({ coin, keywords: parsed.data.keywords ?? [], limit: parsed.data.limit ?? 8 });
        emit("done", `Đã đọc tin ${topic}`);
        return toolResult(result);
      }
      if (call.name === "propose_order") {
        const parsed = orderArgs.safeParse(args);
        if (!parsed.success) return toolResult({ ok: false, error: "INVALID_ARGUMENTS", message: parsed.error.message });
        const symbol = toUsdtSymbol(parsed.data.symbol);
        emit("start", `Đang kiểm tra lệnh ${parsed.data.side} ${symbol}`);
        const result = await tools.proposeOrder({
          symbol,
          side: parsed.data.side,
          stopLoss: parsed.data.stopLoss,
          takeProfit: parsed.data.takeProfit,
          quantity: parsed.data.quantity ?? null,
          reason: parsed.data.reason ?? ""
        });
        if (result.ok) emit("done", `Đã tạo thẻ lệnh ${parsed.data.side} ${symbol}`);
        else emit("error", `Lệnh ${parsed.data.side} ${symbol} bị từ chối`, `${result.code}: ${result.reason}`);
        return toolResult(result.ok ? { ok: true, status: "AWAITING_USER_CONFIRMATION", proposal: result.proposal } : result);
      }
      return toolResult({ ok: false, error: "UNKNOWN_TOOL", message: `No tool named ${call.name}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit("error", `Công cụ ${call.name} lỗi`, message);
      return toolResult({ ok: false, error: "TOOL_FAILED", message });
    }
  }

  private remaining(startedAt: number): number {
    return Math.max(1, this.options.timeoutMs - (this.now() - startedAt));
  }
}

function toUsdtSymbol(symbol: string): string {
  const value = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return value.endsWith("USDT") ? value : `${value}USDT`;
}

function toolResult(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  return text.length <= AI_CHAT_TOOL_RESULT_MAX_CHARS ? text : `${text.slice(0, AI_CHAT_TOOL_RESULT_MAX_CHARS)}…(truncated)`;
}
