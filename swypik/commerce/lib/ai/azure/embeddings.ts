/**
 * Embeddings pe Azure OpenAI (API v1: POST {endpoint}/openai/v1/embeddings).
 * Opțional: fără AZURE_OPENAI_EMBEDDING_DEPLOYMENT (text-embedding-3-small,
 * 1536 dim — compatibil cu coloanele pgvector existente) căutarea semantică e oprită.
 */
import { azureLimits, embeddingDeployment, getAzureOpenAIConfig } from "./config";
import { AzureAIError, azurePost } from "./http";
import { logUsage, parseUsage } from "./usage";

export async function createEmbedding(input: string, feature: string): Promise<number[]> {
  const cfg = getAzureOpenAIConfig();
  const deployment = embeddingDeployment();
  if (!cfg || !deployment) throw new AzureAIError("not_configured", "Azure embeddings are not configured");
  const started = Date.now();
  try {
    const res = await azurePost({
      op: "embeddings",
      url: `${cfg.endpoint}/openai/v1/embeddings`,
      headers: { "Content-Type": "application/json", "api-key": cfg.apiKey },
      body: JSON.stringify({ model: deployment, input: [input] }),
      timeoutMs: azureLimits().safetyTimeoutMs,
    });
    const json = (await res.json().catch(() => null)) as { data?: Array<{ embedding?: unknown }>; usage?: unknown } | null;
    logUsage({ op: "embeddings", feature, deployment, ms: Date.now() - started, ok: true, usage: parseUsage(json?.usage) });
    const vec = json?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || !vec.every((v) => typeof v === "number")) {
      throw new AzureAIError("bad_response", "embeddings: missing vector");
    }
    return vec as number[];
  } catch (err) {
    if (err instanceof AzureAIError && err.code !== "bad_response") {
      logUsage({ op: "embeddings", feature, deployment, ms: Date.now() - started, ok: false, errorCode: err.code });
    }
    throw err;
  }
}
