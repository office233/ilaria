/**
 * Citiri publice pentru misiuni — O SINGURĂ definiție a „misiunii deschise”
 * (folosită de /missions, /missions/[slug], /api/missions, /api/missions/active,
 * validarea legăturii video → misiune și badge-ul din feed).
 */
import { dbQuery } from "@/lib/db";

/** Condiția SQL pentru o misiune la care se mai pot înscrie clipuri (alias `m`). */
export const OPEN_MISSION_SQL = `m.status = 'active'
  AND m.funding_status = 'funded'
  AND m.prize_currency = 'RON'
  AND m.starts_at <= now()
  AND (m.ends_at IS NULL OR m.ends_at > now())`;

type MissionRow = {
  id: string;
  slug: string;
  title: string;
  brief: string | null;
  format_hint: string | null;
  product_id: string | null;
  product_title: string | null;
  product_image: string | null;
  prize_amount_minor: number;
  max_winners: number | null;
  starts_at: string;
  ends_at: string | null;
  submissions_count: number;
};

export type PublicMission = {
  id: string;
  slug: string;
  title: string;
  brief: string | null;
  formatHint: string | null;
  product: { id: string; title: string | null; image: string | null } | null;
  prizeCents: number;
  currency: "RON";
  maxWinners: number | null;
  startsAt: string;
  endsAt: string | null;
  submissionsCount: number;
};

const SELECT_COLS = `m.id, m.slug, m.title, m.brief, m.format_hint, m.product_id,
       p.title AS product_title, p.image_url AS product_image,
       m.prize_amount_minor, m.max_winners, m.starts_at, m.ends_at,
       (SELECT COUNT(*)::int FROM creator_mission_submissions s
         WHERE s.mission_id = m.id AND s.status <> 'rejected') AS submissions_count`;

function toPublic(r: MissionRow): PublicMission {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    brief: r.brief,
    formatHint: r.format_hint,
    product: r.product_id ? { id: r.product_id, title: r.product_title, image: r.product_image } : null,
    prizeCents: Number(r.prize_amount_minor),
    currency: "RON",
    maxWinners: r.max_winners,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    submissionsCount: Number(r.submissions_count),
  };
}

export async function listOpenMissions(limit: number): Promise<PublicMission[]> {
  const safe = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 50)) : 20;
  const { rows } = await dbQuery<MissionRow>(
    `SELECT ${SELECT_COLS}
       FROM creator_missions m
       LEFT JOIN marketplace_products p ON p.id = m.product_id
      WHERE ${OPEN_MISSION_SQL}
      ORDER BY (m.ends_at IS NULL), m.ends_at ASC, m.starts_at DESC
      LIMIT $1`,
    [safe],
  );
  return rows.map(toPublic);
}

export async function getOpenMissionBySlug(slug: string): Promise<PublicMission | null> {
  const { rows } = await dbQuery<MissionRow>(
    `SELECT ${SELECT_COLS}
       FROM creator_missions m
       LEFT JOIN marketplace_products p ON p.id = m.product_id
      WHERE m.slug = $1 AND ${OPEN_MISSION_SQL}
      LIMIT 1`,
    [slug],
  );
  return rows[0] ? toPublic(rows[0]) : null;
}

/** Id-urile misiunilor la care userul are deja un clip activ (pentru picker). */
export async function missionIdsJoinedBy(userId: string): Promise<string[]> {
  const { rows } = await dbQuery<{ mission_id: string }>(
    `SELECT DISTINCT mission_id FROM creator_mission_submissions
      WHERE user_id = $1 AND status <> 'rejected'`,
    [userId],
  );
  return rows.map((r) => r.mission_id);
}
