/**
 * Fire-and-forget auto-embed helper for products / videos.
 *
 * Apelat după INSERT/UPDATE care schimbă title/description.
 * NU blochează request-ul: rulează async și log-uiește warn pe eroare.
 * UPDATE marketplace_products/videos SET embedding = $1::vector, embedding_updated_at = NOW().
 */

import { dbQuery } from "@/lib/db";
import { embed, toPgVector, EmbeddingError, isEmbeddingConfigured } from "@/lib/ai/embeddings";
import { logger } from "@/lib/logger";

type Kind = "product" | "video";

function table(k: Kind): string {
  return k === "product" ? "marketplace_products" : "videos";
}

async function doEmbed(kind: Kind, id: string, text: string): Promise<void> {
  const clean = String(text || "").trim();
  if (!clean) return;
  if (!isEmbeddingConfigured()) return;
  try {
    const vec = await embed(clean);
    await dbQuery(
      `UPDATE ${table(kind)}
          SET embedding = $1::vector, embedding_updated_at = NOW()
        WHERE id = $2`,
      [toPgVector(vec), id]
    );
  } catch (e) {
    const msg = e instanceof EmbeddingError ? `${e.status || ""} ${e.message}` : (e as Error)?.message;
    logger.warn(`[auto-embed:${kind}] ${id}: ${msg}`);
  }
}

/** Fire-and-forget. NU bloca request-ul. */
export function autoEmbedProduct(id: string, title: string | null | undefined, description: string | null | undefined): void {
  const text = `${title || ""}. ${description || ""}`.trim();
  if (!text || !id) return;
  void doEmbed("product", id, text);
}

/** Fire-and-forget. NU bloca request-ul. */
export function autoEmbedVideo(id: string, title: string | null | undefined, description: string | null | undefined, transcript?: string | null): void {
  const text = `${title || ""}. ${description || ""}. ${transcript || ""}`.trim();
  if (!text || !id) return;
  void doEmbed("video", id, text);
}
