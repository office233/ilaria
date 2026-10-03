/**
 * Cozile de moderare pentru /admin/moderation:
 *   reports — rapoarte pe clipuri, grupate pe (clip, motiv)
 *   pending — clipuri noi cu moderation_status = 'pending_review'
 *   flagged — clipuri cu cazuri deschise (semnalate automat de AI sau escaladate)
 */
import { dbQuery } from "@/lib/db";

export const QUEUE_LIMIT = 100;
export const MODERATION_TABS = ["reports", "pending", "flagged"] as const;
export type ModerationTab = (typeof MODERATION_TABS)[number];
export const REPORT_REASONS = ["spam", "harassment", "hate", "violence", "sexual_content", "scam", "copyright", "other"] as const;
export const REPORT_STATUSES = ["open", "triaged", "actioned", "dismissed"] as const;

export function parseModerationTab(v: string | undefined): ModerationTab {
  return (MODERATION_TABS as readonly string[]).includes(v ?? "") ? (v as ModerationTab) : "reports";
}

export type ReportGroup = {
  video_id: string;
  reason: string;
  reports_count: number;
  first_reported_at: string;
  sample_report_id: string;
  title: string | null;
  thumbnail_url: string | null;
  is_hidden: boolean;
  creator_username: string | null;
};

export async function listReportGroups(status: string, reason: string | null): Promise<ReportGroup[]> {
  const args: unknown[] = [status];
  let reasonSql = "";
  if (reason) {
    args.push(reason);
    reasonSql = "AND mr.reason = $2";
  }
  args.push(QUEUE_LIMIT);
  const { rows } = await dbQuery<ReportGroup>(
    `WITH grouped AS (
       SELECT mr.target_video_id, mr.reason, COUNT(*)::int AS reports_count,
              MIN(mr.created_at) AS first_reported_at, MAX(mr.id::text) AS sample_report_id
         FROM moderation_reports mr
        WHERE mr.status = $1 AND mr.target_video_id IS NOT NULL ${reasonSql}
        GROUP BY mr.target_video_id, mr.reason
     )
     SELECT g.target_video_id::text AS video_id, g.reason, g.reports_count, g.first_reported_at::text,
            g.sample_report_id, v.title, v.thumbnail_url, COALESCE(v.is_hidden, false) AS is_hidden,
            u.username AS creator_username
       FROM grouped g
       LEFT JOIN videos v ON v.id = g.target_video_id
       LEFT JOIN users u ON u.id = v.creator_id
      ORDER BY g.reports_count DESC, g.first_reported_at DESC
      LIMIT $${args.length}`,
    args,
  );
  return rows;
}

export type QueueVideo = {
  id: string;
  title: string | null;
  description: string | null;
  thumbnail_url: string | null;
  playback_url: string | null;
  created_at: string;
  moderation_status: string;
  creator_username: string | null;
  /** Motivele semnalării (din moderation_cases.metadata.reasons), doar pentru „flagged”. */
  flag_reasons: string[] | null;
};

const VIDEO_COLUMNS = `v.id::text, v.title, v.description, v.thumbnail_url, v.playback_url, v.created_at::text,
  v.moderation_status, u.username AS creator_username`;

export async function listPendingVideos(): Promise<QueueVideo[]> {
  const { rows } = await dbQuery<QueueVideo>(
    `SELECT ${VIDEO_COLUMNS}, NULL::text[] AS flag_reasons
       FROM videos v LEFT JOIN users u ON u.id = v.creator_id
      WHERE v.moderation_status = 'pending_review' AND COALESCE(v.status, '') <> 'deleted'
      ORDER BY v.created_at ASC
      LIMIT $1`,
    [QUEUE_LIMIT],
  );
  return rows;
}

export async function listFlaggedVideos(): Promise<QueueVideo[]> {
  const { rows } = await dbQuery<QueueVideo>(
    `SELECT ${VIDEO_COLUMNS},
            ARRAY(SELECT DISTINCT jsonb_array_elements_text(COALESCE(c.metadata->'reasons', '[]'::jsonb))
                    FROM moderation_cases c
                   WHERE c.target_video_id = v.id AND c.status IN ('open', 'in_review')
                     AND jsonb_typeof(COALESCE(c.metadata->'reasons', '[]'::jsonb)) = 'array') AS flag_reasons
       FROM videos v LEFT JOIN users u ON u.id = v.creator_id
      WHERE COALESCE(v.status, '') <> 'deleted'
        AND EXISTS (SELECT 1 FROM moderation_cases c
                     WHERE c.target_video_id = v.id AND c.status IN ('open', 'in_review'))
      ORDER BY v.created_at ASC
      LIMIT $1`,
    [QUEUE_LIMIT],
  );
  return rows;
}

export async function moderationCounts(): Promise<Record<ModerationTab, number>> {
  const { rows } = await dbQuery<{ reports: number; pending: number; flagged: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM moderation_reports WHERE status IN ('open', 'triaged')) AS reports,
       (SELECT COUNT(*)::int FROM videos
         WHERE moderation_status = 'pending_review' AND COALESCE(status, '') <> 'deleted') AS pending,
       (SELECT COUNT(DISTINCT target_video_id)::int FROM moderation_cases
         WHERE status IN ('open', 'in_review') AND target_video_id IS NOT NULL) AS flagged`,
  );
  const r = rows[0];
  return { reports: r?.reports ?? 0, pending: r?.pending ?? 0, flagged: r?.flagged ?? 0 };
}
