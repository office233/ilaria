/**
 * Chat completions pe Azure OpenAI (API v1: POST {endpoint}/openai/v1/chat/completions,
 * `model` = numele deployment-ului). Deployment-ul implicit e un model de tip
 * reasoning → `max_completion_tokens` (include tokenii de raționament) și fără
 * `temperature` (doar valoarea implicită e acceptată).
 *
 * `chatJson` = ieșire structurată: `response_format: json_schema` strict, generat
 * din schema zod, iar răspunsul e revalidat cu aceeași schemă.
 */
import type { z } from "zod";
import { azureLimits, chatDeployment, getAzureOpenAIConfig, reasoningEffort } from "./config";
import { AzureAIError, azurePost } from "./http";
import { dropNulls, toStrictJsonSchema } from "./json-schema";
import { logUsage, parseUsage, type TokenUsage } from "./usage";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatOptions = {
  /** Scop pentru jurnalul de consum (ex. "news", "shop-chat"). */
  feature: string;
  /** Include tokenii de raționament — lasă loc suficient (implicit 2000). */
  maxCompletionTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Override deployment (implicit AZURE_OPENAI_CHAT_DEPLOYMENT). */
  deployment?: string;
};

export type ChatResult = { content: string; usage: TokenUsage; finishReason: string | null };

const DEFAULT_MAX_COMPLETION_TOKENS = 2000;

type Completion = {
  choices?: Array<{ message?: { content?: unknown; refusal?: unknown }; finish_reason?: string }>;
  usage?: unknown;
};

async function complete(messages: ChatMessage[], opts: ChatOptions, responseFormat?: unknown): Promise<ChatResult> {
  const cfg = getAzureOpenAIConfig();
  const deployment = opts.deployment || chatDeployment();
  if (!cfg || !deployment) throw new AzureAIError("not_configured", "Azure OpenAI chat is not configured");

  const body: Record<string, unknown> = {
    model: deployment,
    messages,
    max_completion_tokens: opts.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
  };
  const effort = reasoningEffort();
  if (effort) body.reasoning_effort = effort;
  if (responseFormat) body.response_format = responseFormat;

  const started = Date.now();
  try {
    const res = await azurePost({
      op: "chat",
      url: `${cfg.endpoint}/openai/v1/chat/completions`,
      headers: { "Content-Type": "application/json", "api-key": cfg.apiKey },
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs ?? azureLimits().chatTimeoutMs,
      signal: opts.signal,
    });
    const json = (await res.json().catch(() => null)) as Completion | null;
    const choice = json?.choices?.[0];
    const usage = parseUsage(json?.usage);
    const finishReason = choice?.finish_reason ?? null;
    logUsage({ op: "chat", feature: opts.feature, deployment, ms: Date.now() - started, ok: true, usage });
    if (finishReason === "content_filter") throw new AzureAIError("content_filter", "chat: output filtered");
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new AzureAIError("bad_response", `chat: empty content (finish_reason=${finishReason ?? "?"})`);
    }
    return { content, usage, finishReason };
  } catch (err) {
    if (err instanceof AzureAIError && err.code !== "content_filter" && err.code !== "bad_response") {
      logUsage({ op: "chat", feature: opts.feature, deployment, ms: Date.now() - started, ok: false, errorCode: err.code });
    }
    throw err;
  }
}

/** Răspuns text liber. */
export function chatText(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
  return complete(messages, opts);
}

export type ChatJsonOptions<S extends z.ZodType> = ChatOptions & {
  schema: S;
  /** Numele schemei (a-z, 0-9, _ -), cerut de json_schema. */
  schemaName: string;
};

/**
 * Ieșire structurată validată. Aruncă AzureAIError("bad_response") dacă JSON-ul
 * nu se parsează sau nu trece schema zod.
 */
export async function chatJson<S extends z.ZodType>(
  messages: ChatMessage[],
  opts: ChatJsonOptions<S>,
): Promise<{ data: z.infer<S>; usage: TokenUsage }> {
  const responseFormat = {
    type: "json_schema",
    json_schema: { name: opts.schemaName, strict: true, schema: toStrictJsonSchema(opts.schema) },
  };
  const result = await complete(messages, opts, responseFormat);
  let raw: unknown;
  try {
    raw = JSON.parse(result.content);
  } catch {
    throw new AzureAIError("bad_response", "chat: response is not valid JSON");
  }
  const parsed = opts.schema.safeParse(dropNulls(raw));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AzureAIError("bad_response", `chat: schema mismatch at ${issue?.path.join(".") || "root"}: ${issue?.message ?? ""}`);
  }
  return { data: parsed.data, usage: result.usage };
}
