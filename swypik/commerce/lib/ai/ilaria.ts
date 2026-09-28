// Server-side Ilaria transport. Never import this module into a client component.
import "server-only";

export type IlariaRequest = {
  prompt: string;
  history?: { role: "user" | "assistant"; content: string }[];
};

export async function boundedJson(body: ReadableStream<Uint8Array> | null, limit: number): Promise<unknown> {
  if (!body) throw new Error("Missing body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Body exceeds limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function parseIlariaRequest(value: unknown): IlariaRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => k !== "prompt" && k !== "history") ||
      typeof v.prompt !== "string" || !v.prompt.trim()) throw new Error("Invalid prompt");
  const history = v.history ?? [];
  if (!Array.isArray(history) || history.length > 20 || history.length % 2 !== 0) throw new Error("Invalid history");
  for (let i = 0; i < history.length; i++) {
    const turn = history[i];
    if (!turn || typeof turn !== "object" ||
        Object.keys(turn).some(k => k !== "role" && k !== "content") ||
        turn.role !== (i % 2 === 0 ? "user" : "assistant") || typeof turn.content !== "string") {
      throw new Error("Invalid history");
    }
  }
  const request = { prompt: v.prompt, history } as IlariaRequest;
  if (Buffer.byteLength(JSON.stringify(request)) > 64 * 1024) throw new Error("Request exceeds limit");
  return request;
}

export async function queryIlaria(request: IlariaRequest, signal: AbortSignal): Promise<{ reply: string }> {
  const endpoint = new URL(process.env.ILARIA_API_URL || "");
  const token = process.env.ILARIA_API_TOKEN || "";
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
      token.length < 32 || token.trim() !== token) throw new Error("Ilaria is not configured");
  const response = await fetch(new URL("/v1/chat", endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(request),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(125_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Ilaria request failed");
  }
  const result = await boundedJson(response.body, 128 * 1024) as { reply?: unknown };
  if (!result || typeof result.reply !== "string" || !result.reply.trim()) throw new Error("Invalid Ilaria response");
  return { reply: result.reply };
}
