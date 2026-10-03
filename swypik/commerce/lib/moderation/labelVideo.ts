/**
 * labelVideo — classify a video and upsert into video_safety_labels.
 * Heuristic-only: uses the same text classifier on title + description + tags.
 * Visual frame analysis (Sightengine/Hive) will be added later via a separate
 * hook on the processing pipeline once API keys are available.
 */
import { classifyText } from "@/lib/moderation/classifier";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export type VideoLabelInput = {
  id: string;
  title?: string | null;
  description?: string | null;
  tags?: string[] | null;
};

export async function labelVideo(v: VideoLabelInput): Promise<void> {
  try {
    const result = classifyText({
      title: v.title ?? "",
      description: v.description ?? "",
      category: "",
      tags: v.tags ?? [],
    });

    await dbQuery(
      `
      INSERT INTO video_safety_labels
        (video_id, label, classifier_version, reasons, signals, classified_at)
      VALUES ($1, $2, 'v2', $3, $4, now())
      ON CONFLICT (video_id) DO UPDATE SET
        label              = EXCLUDED.label,
        classifier_version = EXCLUDED.classifier_version,
        reasons            = EXCLUDED.reasons,
        signals            = EXCLUDED.signals,
        classified_at      = now(),
        updated_at         = now()
      WHERE video_safety_labels.reviewed_by_human = FALSE
      `,
      [v.id, result.label, result.reasons, result.signals],
    );
  } catch (err) {
    logger.error({ id: v.id, err }, "[labelVideo] failed");
  }
}
