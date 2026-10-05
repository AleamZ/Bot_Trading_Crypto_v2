import { describe, expect, it } from "vitest";
import { DiagnosisSchema, OpenAiCompatibleClient, PatchSchema, extractJson, extractPatch, findJsonObjects } from "../src/llm.js";

describe("extractJson", () => {
  it("parses a plain JSON answer and applies defaults", () => {
    const value = extractJson('{"summary":"ok","severity":"LOW","codeChangeWarranted":false}', DiagnosisSchema);
    expect(value).toEqual({ summary: "ok", findings: [], severity: "low", codeChangeWarranted: false, proposal: "", filesToRead: [] });
  });

  it("prefers fenced json blocks and strips <think> reasoning", () => {
    const raw = `<think>maybe {"summary":"wrong"} hmm</think>
Here is my analysis:
\`\`\`json
{"summary":"right","severity":"high","codeChangeWarranted":true,"filesToRead":["apps/api/src/a.ts"]}
\`\`\`
Thanks!`;
    const value = extractJson(raw, DiagnosisSchema);
    expect(value.summary).toBe("right");
    expect(value.filesToRead).toEqual(["apps/api/src/a.ts"]);
  });

  it("finds JSON embedded in prose, with braces inside strings", () => {
    const raw = 'Sure! {not json} The result: {"title":"fix(engine): x","body":"uses {braces} and \\"quotes\\"","diff":"--- a/x\\n+++ b/x\\n"} end';
    const value = extractJson(raw, PatchSchema);
    expect(value.title).toBe("fix(engine): x");
    expect(value.body).toBe('uses {braces} and "quotes"');
    expect(value.diff).toContain("+++ b/x");
  });

  it("repairs trailing commas", () => {
    expect(extractJson('{"summary":"a","findings":[{"title":"t",},],}', DiagnosisSchema).findings[0]?.title).toBe("t");
  });

  it("skips candidates that fail the schema and throws when none match", () => {
    expect(extractJson('{"foo":1} {"title":"abc","diff":""}', PatchSchema).title).toBe("abc");
    expect(() => extractJson("no json at all", PatchSchema)).toThrow(/No valid JSON/);
    expect(() => extractJson('{"title":"x"}', PatchSchema)).toThrow(/No valid JSON/);
  });

  it("findJsonObjects is linear on unbalanced input", () => {
    expect(findJsonObjects("{ { {")).toEqual([]);
    expect(findJsonObjects('a {"x":{"y":1}} b {"z":2}')).toEqual(['{"x":{"y":1}}', '{"z":2}']);
  });
});

describe("extractPatch", () => {
  it("falls back to a fenced diff block when JSON diff is empty", () => {
    const raw = '{"title":"fix(x): y","body":"b","diff":""}\n```diff\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-a\n+b\n```';
    const patch = extractPatch(raw);
    expect(patch.title).toBe("fix(x): y");
    expect(patch.diff).toContain("+++ b/docs/a.md");
  });

  it("accepts a markdown answer with only a diff block", () => {
    const patch = extractPatch("## fix: improve docs\n```diff\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-a\n+b\n```");
    expect(patch.title).toBe("fix: improve docs");
    expect(patch.diff).toContain("-a");
  });

  it("throws when there is neither JSON nor a diff", () => {
    expect(() => extractPatch("I could not do it")).toThrow();
  });
});

describe("OpenAiCompatibleClient", () => {
  it("posts to /chat/completions and returns the content", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient({ baseUrl: "http://localhost:20128/v1", apiKey: "k", model: "m", timeoutMs: 5_000, temperature: 0.1, fetchImpl });
    await expect(client.complete([{ role: "user", content: "hi" }])).resolves.toBe("hello");
    expect(calls[0]?.url).toBe("http://localhost:20128/v1/chat/completions");
    const body = JSON.parse(String(calls[0]?.init.body)) as { model: string; messages: unknown[] };
    expect(body.model).toBe("m");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("surfaces HTTP errors", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient({ baseUrl: "http://x/v1", apiKey: "", model: "m", timeoutMs: 5_000, temperature: 0, fetchImpl });
    await expect(client.complete([])).rejects.toThrow(/LLM HTTP 500/);
  });
});
