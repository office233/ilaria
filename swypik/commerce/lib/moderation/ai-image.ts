/**
 * moderateImage — Azure AI Content Safety pe imagini încărcate (avatar, copertă
 * video, poze de produs). Imaginea e redusă la max 1024px JPEG înainte de analiză
 * (limita serviciului: 4 MB, 50..7200px) — calitatea nu contează pentru clasificare.
 *
 * Rezultat (praguri CONTENT_SAFETY_IMAGE_REVIEW_AT / _BLOCK_AT):
 *   allow   → ok
 *   review  → apelantul acceptă, dar deschide caz / ține conținutul în review
 *   block   → apelantul respinge încărcarea (422)
 *   unavailable (429 F0, timeout) → tratat ca review („pending review”)
 *   not_configured → allow (dev fără chei)
 */
import sharp from "sharp";
import { AzureAIError, analyzeImage, imageThresholds, isContentSafetyConfigured, safetyVerdict } from "@/lib/ai/azure";
import { MODERATION_UNAVAILABLE } from "@/lib/ai/moderate";
import { logger } from "@/lib/logger";

export type ImageModerationDecision = "allow" | "review" | "block" | "unavailable" | "not_configured";
export type ImageModeration = { decision: ImageModerationDecision; reasons: string[] };

const ANALYSIS_MAX_PX = 1024;

async function prepare(bytes: Uint8Array): Promise<Buffer> {
  return sharp(bytes, { limitInputPixels: 60_000_000 })
    .rotate()
    .resize(ANALYSIS_MAX_PX, ANALYSIS_MAX_PX, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

export async function moderateImage(bytes: Uint8Array, feature: string): Promise<ImageModeration> {
  if (!isContentSafetyConfigured()) return { decision: "not_configured", reasons: [] };
  let prepared: Buffer;
  try {
    prepared = await prepare(bytes);
  } catch {
    // Imaginea nu se decodează — validarea de format a rutei o respinge oricum.
    return { decision: "unavailable", reasons: [MODERATION_UNAVAILABLE] };
  }
  try {
    const verdict = safetyVerdict(await analyzeImage(prepared, feature), imageThresholds());
    return { decision: verdict.decision, reasons: verdict.reasons };
  } catch (err) {
    logger.warn({ feature, code: err instanceof AzureAIError ? err.code : "unknown" }, "[moderate-image] unavailable");
    return { decision: "unavailable", reasons: [MODERATION_UNAVAILABLE] };
  }
}

/** Trebuie ținut în review (semnal AI sau AI indisponibil)? */
export function needsReview(m: ImageModeration): boolean {
  return m.decision === "review" || m.decision === "unavailable";
}
