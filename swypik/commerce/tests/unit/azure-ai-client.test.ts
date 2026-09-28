import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/** lib/ai/azure: chat (json_schema), Whisper, Content Safety — retry 429/5xx, timeout, neconfigurat, usage. */

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: logs }));

import { analyzeImage, analyzeText, chatJson, chatText, safetyVerdict, transcribeAudio, AzureAIError } from "@/lib/ai/azure";
import { toStrictJsonSchema } from "@/lib/ai/azure/json-schema";

const ENV = {
  AZURE_OPENAI_ENDPOINT: "https://res.openai.azure.com/",
  AZURE_OPENAI_API_KEY: "secret-key",
  AZURE_OPENAI_CHAT_DEPLOYMENT: "gpt-5.4-mini",
  AZURE_OPENAI_WHISPER_DEPLOYMENT: "whisper",
  AZURE_CONTENT_SAFETY_ENDPOINT: "https://cs.cognitiveservices.azure.com",
  AZURE_CONTENT_SAFETY_KEY: "cs-key",
};

function completion(content: string, finish = "stop") {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: finish }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 3 } },
    }),
    { status: 200 },
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  Object.assign(process.env, ENV);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  logs.info.mockClear();
});

afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  delete process.env.AZURE_OPENAI_REASONING_EFFORT;
  vi.unstubAllGlobals();
});

describe("chat", () => {
  it("throws not_configured without endpoint/key and never calls fetch", async () => {
    delete process.env.AZURE_OPENAI_API_KEY;
    await expect(chatText([{ role: "user", content: "x" }], { feature: "t" })).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the v1 endpoint, api-key header, deployment as model and reasoning-model params", async () => {
    process.env.AZURE_OPENAI_REASONING_EFFORT = "low";
    fetchMock.mockResolvedValueOnce(completion("salut"));
    const out = await chatText([{ role: "user", content: "hi" }], { feature: "t", maxCompletionTokens: 321 });
    expect(out.content).toBe("salut");
    expect(out.usage).toEqual({ promptTokens: 10, completionTokens: 5, reasoningTokens: 3, totalTokens: 15 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://res.openai.azure.com/openai/v1/chat/completions");
    expect(init.headers["api-key"]).toBe("secret-key");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "gpt-5.4-mini", max_completion_tokens: 321, reasoning_effort: "low" });
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    // usage logat, fără cheie
    const usageLog = JSON.stringify(logs.info.mock.calls);
    expect(usageLog).toContain("\"totalTokens\":15");
    expect(usageLog).not.toContain("secret-key");
  });

  it("retries 429 honouring retry-after-ms, then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after-ms": "5" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 503, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(completion("ok"));
    const out = await chatText([{ role: "user", content: "x" }], { feature: "t" });
    expect(out.content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up with rate_limited when Retry-After exceeds the cap", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429, headers: { "retry-after": "120" } }));
    await expect(chatText([{ role: "user", content: "x" }], { feature: "t" })).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 400; maps the Azure content filter", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"code":"content_filter"}}', { status: 400 }));
    await expect(chatText([{ role: "user", content: "x" }], { feature: "t" })).rejects.toMatchObject({ code: "content_filter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out a hung request", async () => {
    process.env.AZURE_AI_MAX_ATTEMPTS = "1";
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    await expect(chatText([{ role: "user", content: "x" }], { feature: "t", timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
    delete process.env.AZURE_AI_MAX_ATTEMPTS;
  });

  it("chatJson sends a strict json_schema and validates the answer with zod", async () => {
    const schema = z.object({ tags: z.array(z.string()), note: z.string().optional() });
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify({ tags: ["#a"], note: null })));
    const out = await chatJson([{ role: "user", content: "x" }], { feature: "t", schema, schemaName: "tags" });
    expect(out.data).toEqual({ tags: ["#a"] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema).toMatchObject({ name: "tags", strict: true });
    expect(body.response_format.json_schema.schema).toMatchObject({ additionalProperties: false, required: ["tags", "note"] });
  });

  it("chatJson rejects output that does not match the schema", async () => {
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify({ tags: "nope" })));
    const schema = z.object({ tags: z.array(z.string()) });
    await expect(chatJson([{ role: "user", content: "x" }], { feature: "t", schema, schemaName: "tags" })).rejects.toBeInstanceOf(AzureAIError);
  });
});

describe("toStrictJsonSchema", () => {
  it("drops unsupported keywords and makes optional fields nullable + required", () => {
    const s = toStrictJsonSchema(z.object({ a: z.string().min(3).max(9), b: z.number().int().default(1), c: z.enum(["x", "y"]).optional() }));
    expect(s).toMatchObject({ type: "object", additionalProperties: false, required: ["a", "b", "c"] });
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.a).toEqual({ type: "string" });
    expect(props.b.type).toEqual(["integer", "null"]);
    expect(props.c.enum).toEqual(["x", "y", null]);
    expect(JSON.stringify(s)).not.toMatch(/minLength|maxLength|default|\$schema/);
  });
});

describe("whisper", () => {
  it("posts multipart verbose_json + language to the deployment endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "Salut", language: "romanian", duration: 2.5, segments: [{ start: 0, end: 2, text: " Salut " }] })),
    );
    const out = await transcribeAudio(new Uint8Array([1, 2, 3]), { feature: "captions", language: "ro" });
    expect(out).toEqual({ text: "Salut", language: "romanian", duration: 2.5, segments: [{ start: 0, end: 2, text: "Salut" }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://res.openai.azure.com/openai/deployments/whisper/audio/transcriptions?api-version=2024-06-01");
    const form = init.body as FormData;
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("language")).toBe("ro");
  });

  it("refuses files over 25 MB without calling Azure", async () => {
    await expect(transcribeAudio(new Uint8Array(25 * 1024 * 1024 + 1), { feature: "captions" })).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("content safety", () => {
  it("analyzes text and maps severities onto thresholds", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ categoriesAnalysis: [{ category: "Hate", severity: 2 }, { category: "Sexual", severity: 4 }] })),
    );
    const scores = await analyzeText("text", "t");
    expect(scores).toEqual({ Hate: 2, SelfHarm: 0, Sexual: 4, Violence: 0 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cs.cognitiveservices.azure.com/contentsafety/text:analyze?api-version=2024-09-01");
    expect(init.headers["Ocp-Apim-Subscription-Key"]).toBe("cs-key");
    expect(safetyVerdict(scores, { reviewAt: 4, blockAt: 6 })).toEqual({ decision: "review", reasons: ["sexual:4"], maxSeverity: 4 });
    expect(safetyVerdict(scores, { reviewAt: 2, blockAt: 4 }).decision).toBe("block");
    expect(safetyVerdict({ Hate: 0, SelfHarm: 0, Sexual: 0, Violence: 0 }, { reviewAt: 2, blockAt: 4 }).decision).toBe("allow");
  });

  it("F0 429 exhausted → rate_limited error (caller degrades)", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429, headers: { "retry-after-ms": "1" } }));
    await expect(analyzeImage(new Uint8Array([1]), "t")).rejects.toMatchObject({ code: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
