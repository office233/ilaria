/**
 * Coperta / thumbnail-ul unui clip semnalat de moderarea AI a imaginii: caz
 * `image_ai` pe clip + moderation_status → 'pending_review' dacă era aprobat
 * (triggerul din migrarea 0012 recalculează effective_label → dispare din feed).
 * O respingere a adminului nu se atinge. Gate-ul de publicare (lib/video/moderation-gate)
 * nu mai aprobă automat cât timp cazul e deschis.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { ImageModeration } from "./ai-image";
import { openModerationCase } from "./cases";

export async function holdVideoForImageReview(
  videoId: string,
  moderation: ImageModeration,
  metadata: Record<string, unknown>,
): Promise<void> {
  await openModerationCase({
    target: { kind: "video", id: videoId },
    source: "image_ai",
    reasons: moderation.reasons,
    severity: moderation.decision === "unavailable" ? "low" : "medium",
    metadata,
  });
  await dbQuery(
    `UPDATE videos SET moderation_status = 'pending_review', updated_at = NOW()
      WHERE id = $1 AND moderation_status = 'approved'`,
    [videoId],
  ).catch((err) => logger.warn({ err, videoId }, "[video-image] hold failed"));
}
