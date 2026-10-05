import { z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClient {
  complete(messages: ChatMessage[]): Promise<string>;
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  temperature: number;
  fetchImpl?: typeof fetch;
}

/** Minimal client for any OpenAI-compatible /chat/completions endpoint. */
export class OpenAiCompatibleClient implements LlmClient {
  constructor(private readonly options: OpenAiCompatibleOptions) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
      const response = await fetchImpl(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.options.model,
          messages,
          temperature: this.options.temperature,
          stream: false
        }),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 500)}`);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`LLM returned non-JSON payload: ${text.slice(0, 300)}`);
      }
      const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("LLM response has no choices[0].message.content");
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Removes reasoning blocks some local models emit before the answer. */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
}

/** Returns every balanced top-level {...} substring, string/escape aware. */
export function findJsonObjects(text: string): string[] {
  const out: string[] = [];
  let start = text.indexOf("{");
  while (start >= 0) {
    let end = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          out.push(text.slice(start, i + 1));
          break;
        }
      }
    }
    start = text.indexOf("{", end >= 0 ? end + 1 : start + 1);
  }
  return out;
}

function lenientParse(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    // Common local-model glitches: trailing commas, smart quotes.
    const repaired = candidate.replace(/,\s*([}\]])/g, "$1").replace(/[“”]/g, '"');
    return JSON.parse(repaired);
  }
}

/**
 * Extracts the first JSON object from free-form LLM output that satisfies `schema`.
 * Tries fenced ```json blocks first, then every balanced {...} candidate (largest first).
 * The result is plain data – it is never executed.
 */
export function extractJson<S extends z.ZodTypeAny>(raw: string, schema: S): z.infer<S> {
  const text = stripReasoning(raw);
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  candidates.push(text.trim());
  const objects = findJsonObjects(text).sort((a, b) => b.length - a.length);
  candidates.push(...objects);
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    let value: unknown;
    try {
      value = lenientParse(candidate);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data as z.infer<S>;
    errors.push(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  throw new Error(`No valid JSON object in LLM output (${errors.slice(0, 3).join(" | ") || "no candidates"})`);
}

/** Returns the content of the last ```diff / ```patch fenced block, if any. */
export function extractFencedDiff(raw: string): string | null {
  const text = stripReasoning(raw);
  const matches = [...text.matchAll(/```(?:diff|patch)\s*\n([\s\S]*?)```/g)];
  const last = matches[matches.length - 1];
  return last?.[1] ? last[1] : null;
}

export const SeveritySchema = z.enum(["none", "low", "medium", "high", "critical"]);

export const DiagnosisSchema = z.object({
  summary: z.string().default(""),
  findings: z
    .array(
      z.object({
        title: z.string(),
        evidence: z.string().default(""),
        hypothesis: z.string().default("")
      })
    )
    .default([]),
  severity: z.preprocess((value) => (typeof value === "string" ? value.toLowerCase() : value), SeveritySchema).default("none"),
  codeChangeWarranted: z.boolean().default(false),
  proposal: z.string().default(""),
  filesToRead: z.array(z.string()).default([])
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export const PatchSchema = z.object({
  title: z.string().min(3),
  body: z.string().default(""),
  diff: z.string().default("")
});
export type Patch = z.infer<typeof PatchSchema>;

/** Parses a patch response, accepting a fenced ```diff block when the JSON diff is missing/empty. */
export function extractPatch(raw: string): Patch {
  const fenced = extractFencedDiff(raw);
  let patch: Patch;
  try {
    patch = extractJson(raw, PatchSchema);
  } catch (error) {
    if (!fenced) throw error;
    const title = /^#+\s*(.+)$/m.exec(stripReasoning(raw))?.[1]?.trim() ?? "AI proposed improvement";
    return { title, body: "", diff: fenced };
  }
  if (!patch.diff.trim() && fenced) patch = { ...patch, diff: fenced };
  return patch;
}
