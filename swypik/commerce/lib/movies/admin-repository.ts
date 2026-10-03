/**
 * Scrieri admin pentru ingestul Movies: titluri cu licență, licența unui
 * titlu existent, verificarea pregătirii pentru publicare. Titlurile ingerate
 * de admin aparțin contului oficial (Swypik Originals / Open Cinema).
 */
import { dbQuery } from "@/lib/db";
import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";
import { MOVIES_DEFAULT_EPISODE_PRICE_UNITS } from "./config";
import { getSeriesById } from "./repository";
import type { IngestTitleInput } from "./ingest";
import type { LicenseInput } from "./license";
import type { MovieSeriesRow } from "./types";

export async function createIngestedTitle(input: IngestTitleInput, slug: string, adminUserId: string | null): Promise<MovieSeriesRow> {
    const lic = input.license;
    const { rows } = await dbQuery<{ id: string }>(
        `INSERT INTO movie_series (owner_user_id, slug, title, synopsis, genres, language_code, cover_url, poster_url,
                                   free_episodes, episode_price_units, episode_price_cents, is_adult, format,
                                   license_type, attribution_text, license_source_url, license_territories, license_expires_at,
                                   license_recorded_by, license_recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now())
         RETURNING id`,
        [SWYPIK_OFFICIAL_ID, slug, input.title, input.synopsis, input.genres, input.languageCode, input.coverUrl, input.posterUrl,
         input.freeEpisodes, MOVIES_DEFAULT_EPISODE_PRICE_UNITS, input.episodePriceCents, input.isAdult, input.format,
         lic.type, lic.attributionText, lic.sourceUrl, lic.territories, lic.expiresAt, adminUserId],
    );
    const series = await getSeriesById(rows[0].id);
    if (!series) throw new Error("movie_series_insert_lost");
    return series;
}

export async function updateSeriesLicense(seriesId: string, lic: LicenseInput, adminUserId: string | null): Promise<boolean> {
    const { rowCount } = await dbQuery(
        `UPDATE movie_series
            SET license_type = $2, attribution_text = $3, license_source_url = $4, license_territories = $5,
                license_expires_at = $6, license_recorded_by = $7, license_recorded_at = now(), updated_at = now()
          WHERE id = $1`,
        [seriesId, lic.type, lic.attributionText, lic.sourceUrl, lic.territories, lic.expiresAt, adminUserId],
    );
    return (rowCount ?? 0) > 0;
}

/** Episoade totale / aprobate la moderare și gata de redare — condiția de publicare. */
export async function episodeReadiness(seriesId: string): Promise<{ total: number; approved: number }> {
    const { rows } = await dbQuery<{ total: string; approved: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE v.moderation_status = 'approved' AND v.status = 'ready')::text AS approved
           FROM movie_episodes e JOIN videos v ON v.id = e.video_id WHERE e.series_id = $1`,
        [seriesId],
    );
    return { total: Number(rows[0]?.total ?? 0), approved: Number(rows[0]?.approved ?? 0) };
}

/** Un video gata + aprobat, al oricui (adminul poate atașa conținut licențiat urcat de alt cont). */
export async function readyApprovedVideo(videoId: string): Promise<{ duration_ms: number | null } | null> {
    const { rows } = await dbQuery<{ duration_ms: number | null }>(
        `SELECT duration_ms FROM videos WHERE id = $1 AND status = 'ready' AND moderation_status = 'approved'`,
        [videoId],
    );
    return rows[0] ?? null;
}

/** Un video poate fi episod într-un singur titlu (movie_episodes.video_id e UNIQUE). */
export async function isVideoAttached(videoId: string): Promise<boolean> {
    const { rows } = await dbQuery(`SELECT 1 FROM movie_episodes WHERE video_id = $1`, [videoId]);
    return rows.length > 0;
}
