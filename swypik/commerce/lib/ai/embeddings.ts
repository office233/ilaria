/**
 * Embeddings pentru căutare semantică (pgvector 1536 dim) — Azure OpenAI.
 * Necesită AZURE_OPENAI_EMBEDDING_DEPLOYMENT (text-embedding-3-small); fără el
 * `embed` aruncă EmbeddingError și apelanții sar peste (fire-and-forget).
 */
import { AzureAIError, createEmbedding, isAzureEmbeddingConfigured } from "./azure";

export const EMBEDDING_DIM = 1536;

export class EmbeddingError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "EmbeddingError";
    this.status = status;
  }
}

export function isEmbeddingConfigured(): boolean {
  return isAzureEmbeddingConfigured();
}

export async function embed(text: string): Promise<number[]> {
  if (!isAzureEmbeddingConfigured()) throw new EmbeddingError("AZURE_OPENAI_EMBEDDING_DEPLOYMENT missing");
  const input = String(text || "").slice(0, 8000).trim();
  if (!input) throw new EmbeddingError("empty input");
  let vec: number[];
  try {
    vec = await createEmbedding(input, "embeddings");
  } catch (e) {
    const status = e instanceof AzureAIError ? e.status : undefined;
    throw new EmbeddingError(e instanceof Error ? e.message : "embedding failed", status);
  }
  if (vec.length !== EMBEDDING_DIM) throw new EmbeddingError(`Unexpected embedding shape len=${vec.length}`);
  return vec;
}

/** Convert number[] → pgvector literal text `[v1,v2,...]` (cu precizie redusă pentru size). */
export function toPgVector(vec: number[]): string {
  return "[" + vec.map((v) => v.toFixed(6)).join(",") + "]";
}
