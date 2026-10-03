/**
 * Moderarea textului la publicare (pe titlul/descrierea/hashtag-urile FINALE).
 * Rezultatul scrie `videos.moderation_status`; trigger-ul din migrarea 0012
 * îl transformă în `effective_label`, deci clipurile pending/rejected nu apar
 * în niciun feed.
 *
 * VIDEO_MODERATION_MODE:
 *   auto   (implicit) — textul curat e aprobat automat; orice semnal (clasificator
 *                       euristic adult/blocked sau AI flagged) → coada de review.
 *   manual            — orice clip așteaptă aprobarea unui admin (pre-moderare).
 */
import { dbQuery } from "@/lib/db";
import { moderate } from "@/lib/ai/moderate";
import { hasOpenImageCase } from "@/lib/moderation/cases";
import { classifyText } from "@/lib/moderation/classifier";
import { labelVideo } from "@/lib/moderation/labelVideo";
import { recordStrike } from "@/lib/moderation/strikes";
import { logger } from "@/lib/logger";

export type ModerationDecision = "approved" | "pending_review" | "rejected";

export function moderationMode(): "auto" | "manual" {
  return (process.env.VIDEO_MODERATION_MODE || "").trim().toLowerCase() === "manual" ? "manual" : "auto";
}

export type ModerationInput = {
  videoId: string;
  creatorId: string;
  currentStatus: string;
  title: string;
  description: string;
  tags: string[];
};

export async function moderateOnPublish(input: ModerationInput): Promise<ModerationDecision> {
  // O respingere a unui admin nu poate fi anulată republicând.
  if (input.currentStatus === "rejected") return "rejected";

  const text = `${input.title}\n${input.description}`.trim();
  const heuristic = classifyText({ title: input.title, description: input.description, category: "", tags: input.tags });
  await labelVideo({ id: input.videoId, title: input.title, description: input.description, tags: input.tags });

  if (heuristic.label === "adult" || heuristic.label === "blocked") {
    void recordStrike({
      userId: input.creatorId,
      label: heuristic.label,
      context: "video",
      refType: "video",
      refId: input.videoId,
      reasons: heuristic.reasons,
      signals: heuristic.signals as Record<string, unknown>,
    });
    await openCase(input.videoId, heuristic.reasons, "classifier", text);
    return "pending_review";
  }

  // Azure Content Safety; indisponibil (429 F0 / timeout) → reasons=["moderation_unavailable"] → review.
  const ai = await moderate(text);
  if (ai.flagged) {
    await openCase(input.videoId, ai.reasons, "ai_auto", text);
    return "pending_review";
  }
  // Thumbnail/coperta semnalate de workerul video sau de ruta cover → rămân în review.
  if (await hasOpenImageCase(input.videoId)) return "pending_review";
  return moderationMode() === "manual" ? "pending_review" : "approved";
}

async function openCase(videoId: string, reasons: string[], source: string, text: string): Promise<void> {
  await dbQuery(
    `INSERT INTO moderation_cases (target_video_id, severity, status, metadata, created_at, updated_at)
     SELECT $1, 'medium', 'open', $2::jsonb, NOW(), NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM moderation_cases WHERE target_video_id = $1 AND status = 'open'
      )`,
    [videoId, JSON.stringify({ reasons, source, text: text.slice(0, 500) })],
  ).catch((err) => logger.warn({ err, videoId }, "[moderation-gate] case insert failed"));
}
