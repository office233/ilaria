import { dbQuery, withTransaction, type TxQuery } from "@/lib/db";
import { isFreeEpisode, isSeriesPublic } from "./access";
import { isPrivateMediaUrl } from "@/lib/media/stream-proxy";
import { privatizePaidEpisodeMedia, type PrivatizeReport } from "./private-media";
import type { MovieEpisodeRow, MovieSeriesRow } from "./types";

/**
 * Un episod blocat NU are voie să fie `public` în `videos`: feed-ul, căutarea și
 * pagina /v/[id] filtrează pe visibility='public', deci `private` este ceea ce
 * ține episoadele plătite în afara oricărei suprafețe, în afară de player-ul
 * Movies (care citește playback_url server-side, după verificarea accesului).
 */
export function targetVisibility(
    series: Pick<MovieSeriesRow, "free_episodes" | "status"> & { license_expires_at?: string | null },
    episode: Pick<MovieEpisodeRow, "episode_number" | "status"> & { media_private?: boolean },
    now: number = Date.now(),
): "public" | "private" {
    // Licența expirată scoate titlul de peste tot, inclusiv episoadele gratuite din feed.
    if (!isSeriesPublic(series, now) || episode.status !== "published") return "private";
    // Media în prefixul privat nu se poate reda din feed (fără token) — rămâne doar în player-ul Movies.
    if (episode.media_private) return "private";
    return isFreeEpisode(series, episode) ? "public" : "private";
}

/** Aliniază `videos.visibility` pentru toate episoadele unui serial (în tranzacția apelantului). */
export async function syncEpisodeVisibility(q: TxQuery, seriesId: string): Promise<{ made_public: number; made_private: number }> {
    const { rows } = await q<{ free_episodes: number; status: MovieSeriesRow["status"]; license_expires_at: string | null }>(
        `SELECT free_episodes, status, license_expires_at FROM movie_series WHERE id = $1 FOR UPDATE`,
        [seriesId],
    );
    const series = rows[0];
    if (!series) return { made_public: 0, made_private: 0 };

    const { rows: episodeRows } = await q<Pick<MovieEpisodeRow, "video_id" | "episode_number" | "status"> & { playback_url: string | null }>(
        `SELECT e.video_id, e.episode_number, e.status, v.playback_url
           FROM movie_episodes e LEFT JOIN videos v ON v.id = e.video_id WHERE e.series_id = $1`,
        [seriesId],
    );
    const episodes = episodeRows.map((e) => ({ ...e, media_private: Boolean(e.playback_url && isPrivateMediaUrl(e.playback_url)) }));
    const publicIds = episodes.filter((e) => targetVisibility(series, e) === "public").map((e) => e.video_id);
    const privateIds = episodes.filter((e) => targetVisibility(series, e) === "private").map((e) => e.video_id);

    const pub = publicIds.length
        ? await q(`UPDATE videos SET visibility = 'public', updated_at = now() WHERE id = ANY($1::uuid[]) AND visibility <> 'public'`, [publicIds])
        : { rowCount: 0 };
    const priv = privateIds.length
        ? await q(`UPDATE videos SET visibility = 'private', updated_at = now() WHERE id = ANY($1::uuid[]) AND visibility <> 'private'`, [privateIds])
        : { rowCount: 0 };
    return { made_public: pub.rowCount, made_private: priv.rowCount };
}

/**
 * Job zilnic (cron daily-maintenance): titlurile publicate a căror licență a
 * expirat între timp își pierd vizibilitatea publică a episoadelor gratuite
 * (paginile/API-urile Movies le ascund deja pe baza datei). Tot aici, plasa de
 * siguranță P0: orice episod plătit rămas cu media în prefixul public (ex.
 * re-encode, eroare trecătoare la atașare) e mutat în prefixul privat.
 */
export async function privatizeExpiredMovieTitles(): Promise<{ series: number; made_private: number; paid_media: PrivatizeReport }> {
    const { rows } = await dbQuery<{ id: string }>(
        `SELECT s.id FROM movie_series s
          WHERE s.status = 'published' AND s.license_expires_at IS NOT NULL AND s.license_expires_at <= now()
            AND EXISTS (SELECT 1 FROM movie_episodes e JOIN videos v ON v.id = e.video_id
                         WHERE e.series_id = s.id AND v.visibility = 'public')`,
    );
    let madePrivate = 0;
    for (const r of rows) {
        const res = await withTransaction((q) => syncEpisodeVisibility(q, r.id));
        madePrivate += res.made_private;
    }
    const paidMedia = await privatizePaidEpisodeMedia();
    return { series: rows.length, made_private: madePrivate, paid_media: paidMedia };
}
