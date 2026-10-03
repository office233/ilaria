/**
 * Cazuri de moderare deschise automat (AI) în `moderation_cases`, fără duplicate:
 * cel mult un caz „open” per țintă și sursă. Coada din /admin/moderation le preia.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export type CaseTarget = { kind: "video" | "comment" | "user"; id: string };
export type CaseSource = "ai_auto" | "image_ai" | "classifier";

const TARGET_COLUMN: Record<CaseTarget["kind"], string> = {
  video: "target_video_id",
  comment: "target_comment_id",
  user: "target_user_id",
};

export async function openModerationCase(input: {
  target: CaseTarget;
  source: CaseSource;
  reasons: string[];
  severity?: "low" | "medium" | "high";
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const col = TARGET_COLUMN[input.target.kind];
  const metadata = { ...input.metadata, reasons: input.reasons, source: input.source };
  await dbQuery(
    `INSERT INTO moderation_cases (${col}, severity, status, metadata, created_at, updated_at)
     SELECT $1, $2, 'open', $3::jsonb, NOW(), NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM moderation_cases
         WHERE ${col} = $1 AND status = 'open' AND metadata->>'source' = $4
      )`,
    [input.target.id, input.severity ?? "medium", JSON.stringify(metadata), input.source],
  ).catch((err) => logger.warn({ err, target: input.target }, "[moderation-cases] insert failed"));
}

/** Există un caz deschis de moderarea AI a imaginii (thumbnail/copertă) pe clip? */
export async function hasOpenImageCase(videoId: string): Promise<boolean> {
  try {
    const { rows } = await dbQuery<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM moderation_cases
          WHERE target_video_id = $1 AND status = 'open' AND metadata->>'source' = 'image_ai'
       ) AS ok`,
      [videoId],
    );
    return Boolean(rows[0]?.ok);
  } catch (err) {
    logger.warn({ err, videoId }, "[moderation-cases] image case lookup failed");
    return false;
  }
}
