/**
 * Date pentru badge-ul „Misiune” din feed: pentru un set de clipuri, misiunea
 * la care participă fiecare (dacă există) + dacă a câștigat.
 *
 * Folosire (feed / card video):
 *   const badges = await getMissionBadges(videos.map((v) => v.id));
 *   const badge = badges.get(video.id); // MissionBadge | undefined
 *
 * Doar înscrierile active (nu 'rejected') la misiuni RON finanțate și
 * nearhivate. Un clip are cel mult o înscriere activă (index unic).
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export type MissionBadge = {
  missionId: string;
  slug: string;
  title: string;
  prizeCents: number;
  currency: "RON";
  /** true dacă misiunea mai primește clipuri (CTA „Participă și tu”). */
  open: boolean;
  /** true dacă acest clip a câștigat premiul. */
  winner: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 100;

type Row = {
  video_id: string;
  mission_id: string;
  slug: string;
  title: string;
  prize_amount_minor: number;
  open: boolean;
  winner: boolean;
};

export async function getMissionBadges(videoIds: readonly string[]): Promise<Map<string, MissionBadge>> {
  const ids = Array.from(new Set(videoIds.filter((id) => UUID_RE.test(id)))).slice(0, MAX_IDS);
  const out = new Map<string, MissionBadge>();
  if (ids.length === 0) return out;
  try {
    const { rows } = await dbQuery<Row>(
      `SELECT s.video_id::text AS video_id, m.id AS mission_id, m.slug, m.title, m.prize_amount_minor,
              (m.status = 'active' AND (m.ends_at IS NULL OR m.ends_at > now())) AS open,
              (s.status = 'paid') AS winner
         FROM creator_mission_submissions s
         JOIN creator_missions m ON m.id = s.mission_id
        WHERE s.video_id = ANY($1::uuid[])
          AND s.status <> 'rejected'
          AND m.funding_status IN ('funded', 'refunded')
          AND m.prize_currency = 'RON'
          AND m.status <> 'archived'`,
      [ids],
    );
    for (const r of rows) {
      out.set(r.video_id, {
        missionId: r.mission_id,
        slug: r.slug,
        title: r.title,
        prizeCents: Number(r.prize_amount_minor),
        currency: "RON",
        open: !!r.open,
        winner: !!r.winner,
      });
    }
  } catch (err) {
    // Badge-ul e decorativ: feed-ul nu trebuie să cadă din cauza lui.
    logger.warn({ err }, "missions.feed_badge.failed");
  }
  return out;
}
