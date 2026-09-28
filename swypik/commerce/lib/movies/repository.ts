import { dbQuery, withTransaction } from "@/lib/db";
import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";
import type { MovieEpisodeRow, MovieEpisodeWithThumb, MovieProgressRow, MovieSeriesRow, SeriesStatus } from "./types";
import { syncEpisodeVisibility } from "./visibility";
import { privatizeSeriesMediaSafely } from "./private-media";

const SERIES_COLS = `id, slug, owner_user_id, title, synopsis, genres, language_code, cover_url, poster_url,
    trailer_video_id, status, free_episodes, episode_price_units::text AS episode_price_units,
    episode_price_cents::text AS episode_price_cents, is_adult,
    license_note, format, license_type, attribution_text, license_source_url, license_territories,
    license_expires_at, published_at, created_at, updated_at`;

/** Titlu vizibil public: publicat și cu licența neexpirată (alias `s`). */
export const PUBLIC_SERIES_SQL = `s.status = 'published' AND (s.license_expires_at IS NULL OR s.license_expires_at > now())`;

/** Aceleași coloane, prefixate cu aliasul `s.` (pentru JOIN-uri). */
const SERIES_COLS_S = SERIES_COLS.split(",").map((c) => `s.${c.trim()}`).join(", ");

function normalizeSeries<T extends { episode_price_units: string | number; episode_price_cents: string | number | null }>(
    row: T,
): T & { episode_price_units: number; episode_price_cents: number | null } {
    return {
        ...row,
        episode_price_units: Number(row.episode_price_units),
        episode_price_cents: row.episode_price_cents === null ? null : Number(row.episode_price_cents),
    };
}

export async function getSeriesBySlug(slug: string): Promise<MovieSeriesRow | null> {
    const { rows } = await dbQuery<MovieSeriesRow>(`SELECT ${SERIES_COLS} FROM movie_series WHERE slug = $1`, [slug]);
    return rows[0] ? normalizeSeries(rows[0]) : null;
}

export async function getSeriesById(id: string): Promise<MovieSeriesRow | null> {
    const { rows } = await dbQuery<MovieSeriesRow>(`SELECT ${SERIES_COLS} FROM movie_series WHERE id = $1`, [id]);
    return rows[0] ? normalizeSeries(rows[0]) : null;
}

export type ListSeriesOpts = { genre?: string; sort: "trending" | "new"; limit: number; offset: number; includeAdult: boolean };

/** Trending = deblocări + progres în ultimele 7 zile; New = published_at. */
export async function listPublishedSeries(opts: ListSeriesOpts) {
    const params: unknown[] = [opts.limit, opts.offset];
    const where: string[] = [PUBLIC_SERIES_SQL];
    if (!opts.includeAdult) where.push(`s.is_adult = false`);
    if (opts.genre) {
        params.push(opts.genre);
        where.push(`$${params.length} = ANY(s.genres)`);
    }
    const order = opts.sort === "new"
        ? `s.published_at DESC NULLS LAST`
        : `(SELECT COUNT(*) FROM movie_unlocks u WHERE u.series_id = s.id AND u.created_at > now() - interval '7 days')
           + (SELECT COUNT(*) FROM movie_watch_progress p JOIN movie_episodes e ON e.id = p.episode_id
              WHERE e.series_id = s.id AND p.updated_at > now() - interval '7 days') DESC, s.published_at DESC`;
    const { rows } = await dbQuery<MovieSeriesRow & { episode_count: number; owner_name: string | null }>(
        `SELECT ${SERIES_COLS_S},
                (SELECT COUNT(*) FROM movie_episodes e WHERE e.series_id = s.id AND e.status = 'published')::int AS episode_count,
                u.display_name AS owner_name
           FROM movie_series s
           LEFT JOIN users u ON u.id = s.owner_user_id
          WHERE ${where.join(" AND ")}
          ORDER BY ${order}
          LIMIT $1 OFFSET $2`,
        params,
    );
    return rows.map(normalizeSeries);
}

export async function listEpisodes(seriesId: string, opts: { publishedOnly?: boolean } = {}): Promise<MovieEpisodeWithThumb[]> {
    const { rows } = await dbQuery<MovieEpisodeWithThumb>(
        `SELECT e.id, e.series_id, e.episode_number, e.video_id, e.title,
                COALESCE(e.duration_ms, v.duration_ms) AS duration_ms, e.status, e.created_at, e.updated_at,
                v.thumbnail_url
           FROM movie_episodes e
           LEFT JOIN videos v ON v.id = e.video_id
          WHERE e.series_id = $1 ${opts.publishedOnly ? `AND e.status = 'published'` : ``}
          ORDER BY e.episode_number ASC`,
        [seriesId],
    );
    return rows;
}

/** Serialele contului oficial („Swypik Originals"), publicate, cele mai noi primele. */
export async function listOriginals(limit: number, includeAdult: boolean) {
    const { rows } = await dbQuery<MovieSeriesRow & { episode_count: number; owner_name: string | null }>(
        `SELECT ${SERIES_COLS_S},
                (SELECT COUNT(*) FROM movie_episodes e WHERE e.series_id = s.id AND e.status = 'published')::int AS episode_count,
                u.display_name AS owner_name
           FROM movie_series s
           LEFT JOIN users u ON u.id = s.owner_user_id
          WHERE ${PUBLIC_SERIES_SQL} AND s.owner_user_id = $1 ${includeAdult ? `` : `AND s.is_adult = false`}
          ORDER BY s.published_at DESC NULLS LAST
          LIMIT $2`,
        [SWYPIK_OFFICIAL_ID, limit],
    );
    return rows.map(normalizeSeries);
}

export async function listWatchlist(userId: string, limit: number) {
    const { rows } = await dbQuery<MovieSeriesRow & { episode_count: number; owner_name: string | null }>(
        `SELECT ${SERIES_COLS_S},
                (SELECT COUNT(*) FROM movie_episodes e WHERE e.series_id = s.id AND e.status = 'published')::int AS episode_count,
                u.display_name AS owner_name
           FROM movie_watchlist w
           JOIN movie_series s ON s.id = w.series_id
           LEFT JOIN users u ON u.id = s.owner_user_id
          WHERE w.user_id = $1 AND ${PUBLIC_SERIES_SQL}
          ORDER BY w.created_at DESC
          LIMIT $2`,
        [userId, limit],
    );
    return rows.map(normalizeSeries);
}

export async function isInWatchlist(userId: string, seriesId: string): Promise<boolean> {
    const { rows } = await dbQuery(`SELECT 1 FROM movie_watchlist WHERE user_id = $1 AND series_id = $2`, [userId, seriesId]);
    return rows.length > 0;
}

export async function addToWatchlist(userId: string, seriesId: string): Promise<void> {
    await dbQuery(`INSERT INTO movie_watchlist (user_id, series_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, seriesId]);
}

export async function removeFromWatchlist(userId: string, seriesId: string): Promise<void> {
    await dbQuery(`DELETE FROM movie_watchlist WHERE user_id = $1 AND series_id = $2`, [userId, seriesId]);
}

export async function getEpisode(seriesId: string, episodeNumber: number): Promise<MovieEpisodeRow | null> {
    const { rows } = await dbQuery<MovieEpisodeRow>(
        `SELECT id, series_id, episode_number, video_id, title, duration_ms, status, created_at, updated_at
           FROM movie_episodes WHERE series_id = $1 AND episode_number = $2`,
        [seriesId, episodeNumber],
    );
    return rows[0] ?? null;
}

export async function getEpisodeById(id: string) {
    const { rows } = await dbQuery<MovieEpisodeRow & { playback_url: string | null; thumbnail_url: string | null }>(
        `SELECT e.id, e.series_id, e.episode_number, e.video_id, e.title,
                COALESCE(e.duration_ms, v.duration_ms) AS duration_ms, e.status, e.created_at, e.updated_at,
                v.playback_url, v.thumbnail_url
           FROM movie_episodes e JOIN videos v ON v.id = e.video_id WHERE e.id = $1`,
        [id],
    );
    return rows[0] ?? null;
}

export async function getViewerUnlocks(userId: string, seriesId: string): Promise<{ episodeIds: Set<string>; season: boolean }> {
    const { rows } = await dbQuery<{ episode_id: string | null }>(
        `SELECT episode_id FROM movie_unlocks WHERE user_id = $1 AND series_id = $2 AND status = 'paid'`,
        [userId, seriesId],
    );
    return {
        episodeIds: new Set(rows.map((r) => r.episode_id).filter((x): x is string => Boolean(x))),
        season: rows.some((r) => r.episode_id === null),
    };
}

export async function getProgress(userId: string, seriesId: string): Promise<MovieProgressRow[]> {
    const { rows } = await dbQuery<MovieProgressRow>(
        `SELECT p.user_id, p.episode_id, p.position_ms, p.completed, p.updated_at
           FROM movie_watch_progress p JOIN movie_episodes e ON e.id = p.episode_id
          WHERE p.user_id = $1 AND e.series_id = $2`,
        [userId, seriesId],
    );
    return rows;
}

export async function upsertProgress(userId: string, episodeId: string, positionMs: number, completed: boolean): Promise<void> {
    await dbQuery(
        `INSERT INTO movie_watch_progress (user_id, episode_id, position_ms, completed)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, episode_id) DO UPDATE
            SET position_ms = EXCLUDED.position_ms,
                completed = movie_watch_progress.completed OR EXCLUDED.completed,
                updated_at = now()`,
        [userId, episodeId, positionMs, completed],
    );
}

export async function listContinueWatching(userId: string, limit: number) {
    const { rows } = await dbQuery<{ series: MovieSeriesRow; episode: MovieEpisodeRow; position_ms: number }>(
        `SELECT DISTINCT ON (s.id)
                to_jsonb(s) AS series, to_jsonb(e) AS episode, p.position_ms
           FROM movie_watch_progress p
           JOIN movie_episodes e ON e.id = p.episode_id
           JOIN movie_series s ON s.id = e.series_id
          WHERE p.user_id = $1 AND p.completed = false AND ${PUBLIC_SERIES_SQL}
          ORDER BY s.id, p.updated_at DESC
          LIMIT $2`,
        [userId, limit],
    );
    return rows.map((r) => ({ ...r, series: normalizeSeries(r.series) }));
}

export async function isPublisher(userId: string): Promise<boolean> {
    const { rows } = await dbQuery(`SELECT 1 FROM movie_publishers WHERE user_id = $1`, [userId]);
    return rows.length > 0;
}

export type CreateSeriesInput = {
    ownerUserId: string;
    slug: string;
    title: string;
    synopsis: string;
    genres: string[];
    languageCode: string;
    coverUrl: string | null;
    posterUrl: string | null;
    freeEpisodes: number;
    /** Legacy — nu mai e editabil din UI; păstrat doar pt. constrângerea NOT NULL a coloanei vechi. */
    episodePriceUnits: number;
    /** Preț RON (cenți) per episod. `null` = creatorul nu l-a setat încă ("preț în curând"). */
    episodePriceCents: number | null;
    isAdult: boolean;
    licenseNote: string | null;
};

export async function createSeries(i: CreateSeriesInput): Promise<MovieSeriesRow> {
    const { rows } = await dbQuery<MovieSeriesRow>(
        `INSERT INTO movie_series (owner_user_id, slug, title, synopsis, genres, language_code, cover_url, poster_url,
                                   free_episodes, episode_price_units, episode_price_cents, is_adult, license_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING ${SERIES_COLS}`,
        [i.ownerUserId, i.slug, i.title, i.synopsis, i.genres, i.languageCode, i.coverUrl, i.posterUrl,
         i.freeEpisodes, i.episodePriceUnits, i.episodePriceCents, i.isAdult, i.licenseNote],
    );
    return normalizeSeries(rows[0]);
}

export type UpdateSeriesPatch = Partial<Omit<CreateSeriesInput, "ownerUserId" | "slug">> & {
    status?: SeriesStatus;
    trailerVideoId?: string | null;
};

const PATCH_COLUMNS: Record<keyof UpdateSeriesPatch, string> = {
    title: "title",
    synopsis: "synopsis",
    genres: "genres",
    languageCode: "language_code",
    coverUrl: "cover_url",
    posterUrl: "poster_url",
    freeEpisodes: "free_episodes",
    episodePriceUnits: "episode_price_units",
    episodePriceCents: "episode_price_cents",
    isAdult: "is_adult",
    licenseNote: "license_note",
    status: "status",
    trailerVideoId: "trailer_video_id",
};

/** `ownerUserId === null` = admin (fără restricție de owner). Re-sincronizează vizibilitatea episoadelor. */
export async function updateSeries(id: string, ownerUserId: string | null, patch: UpdateSeriesPatch): Promise<MovieSeriesRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, col] of Object.entries(PATCH_COLUMNS) as Array<[keyof UpdateSeriesPatch, string]>) {
        if (patch[key] === undefined) continue;
        params.push(patch[key]);
        sets.push(`${col} = $${params.length}`);
    }
    if (patch.status === "published") sets.push(`published_at = COALESCE(published_at, now())`);
    if (sets.length === 0) return getSeriesById(id);
    if (ownerUserId) params.push(ownerUserId);
    const updated = await withTransaction(async (q) => {
        const { rows } = await q<MovieSeriesRow>(
            `UPDATE movie_series SET ${sets.join(", ")}, updated_at = now()
              WHERE id = $1 ${ownerUserId ? `AND owner_user_id = $${params.length}` : ``}
              RETURNING ${SERIES_COLS}`,
            params,
        );
        if (!rows[0]) return null;
        await syncEpisodeVisibility(q, id);
        return normalizeSeries(rows[0]);
    });
    // Episoadele devenite plătite (free_episodes micșorat) își mută media în prefixul privat.
    if (updated) await privatizeSeriesMediaSafely(id);
    return updated;
}

export async function addEpisode(i: { seriesId: string; episodeNumber: number; videoId: string; title: string; durationMs: number | null }): Promise<MovieEpisodeRow> {
    const episode = await withTransaction(async (q) => {
        const { rows } = await q<MovieEpisodeRow>(
            `INSERT INTO movie_episodes (series_id, episode_number, video_id, title, duration_ms, status)
             VALUES ($1, $2, $3, $4, $5, 'published')
             RETURNING id, series_id, episode_number, video_id, title, duration_ms, status, created_at, updated_at`,
            [i.seriesId, i.episodeNumber, i.videoId, i.title, i.durationMs],
        );
        await syncEpisodeVisibility(q, i.seriesId);
        return rows[0];
    });
    // Un video existent atașat ca episod plătit iese imediat din prefixul public.
    await privatizeSeriesMediaSafely(i.seriesId);
    return episode;
}

export async function listSeriesForOwner(ownerUserId: string) {
    const { rows } = await dbQuery<MovieSeriesRow & { episode_count: number }>(
        `SELECT ${SERIES_COLS_S},
                (SELECT COUNT(*) FROM movie_episodes e WHERE e.series_id = s.id)::int AS episode_count
           FROM movie_series s WHERE s.owner_user_id = $1 ORDER BY s.updated_at DESC`,
        [ownerUserId],
    );
    return rows.map(normalizeSeries);
}

export async function listSeriesForAdmin(status?: SeriesStatus) {
    const { rows } = await dbQuery<MovieSeriesRow & { episode_count: number; owner_name: string | null }>(
        `SELECT ${SERIES_COLS_S},
                (SELECT COUNT(*) FROM movie_episodes e WHERE e.series_id = s.id)::int AS episode_count,
                u.display_name AS owner_name
           FROM movie_series s LEFT JOIN users u ON u.id = s.owner_user_id
          ${status ? `WHERE s.status = $1` : ``}
          ORDER BY s.updated_at DESC LIMIT 200`,
        status ? [status] : [],
    );
    return rows.map(normalizeSeries);
}

export async function ownsReadyVideo(userId: string, videoId: string) {
    const { rows } = await dbQuery<{ duration_ms: number | null; moderation_status: string }>(
        `SELECT duration_ms, moderation_status FROM videos
          WHERE id = $1 AND creator_id = $2 AND status = 'ready' AND is_hidden = false
            AND moderation_status = 'approved'`,
        [videoId, userId],
    );
    return rows[0] ?? null;
}

/**
 * Câștigurile creatorului: suma (cenți RON) e calculată DOAR din deblocările
 * plătite cu cardul (Stripe) — `payment_intent_id IS NOT NULL AND status = 'paid'`.
 * Deblocările legacy din era SWYP (fără plată cu cardul) nu intră în sumă,
 * dar contează în continuare la `unlocks` (statistica de "câte deblocări").
 */
export async function creatorShareTotals(ownerUserId: string): Promise<{ total_units: number; unlocks: number }> {
    const { rows } = await dbQuery<{ total_units: string; unlocks: string }>(
        `SELECT COALESCE(SUM(u.creator_share_units) FILTER (
                    WHERE u.payment_intent_id IS NOT NULL AND u.status = 'paid'
                ), 0)::text AS total_units,
                COUNT(*) FILTER (WHERE u.status = 'paid')::text AS unlocks
           FROM movie_unlocks u JOIN movie_series s ON s.id = u.series_id
          WHERE s.owner_user_id = $1`,
        [ownerUserId],
    );
    return { total_units: Number(rows[0]?.total_units ?? 0), unlocks: Number(rows[0]?.unlocks ?? 0) };
}
