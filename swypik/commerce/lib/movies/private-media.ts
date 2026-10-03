/**
 * P0 (audit 2 stays-media): media unui episod PLĂTIT nu are voie să stea în
 * prefixul public (`videos/hls/<id>/`) — thumbnail-ul public dezvăluia
 * directorul, iar `master.m3u8` din același director se reda fără token.
 *
 * `ensureEpisodeMediaPrivate` (idempotent, serializat per video):
 *   1. copiază directorul HLS într-un director privat ALEATOR (`private/movies/<rnd>/`);
 *   2. copiază thumbnail-ul la o cheie publică aleatoare (`movies/thumbs/<rnd>.jpg`);
 *   3. actualizează `videos` (playback_url, thumbnail_url, fără preview/audio URL);
 *   4. abia apoi șterge copiile publice.
 * Rulat la atașarea episodului, la orice schimbare a titlului (free_episodes,
 * publicare), de pe ruta play ca plasă de siguranță, de cron-ul zilnic și de
 * ruta admin de migrare one-shot (`POST /api/admin/movies/privatize-media`).
 */
import { dbQuery, withAdvisoryLock } from "@/lib/db";
import { isStorageConfigured, mediaPublicUrl } from "@/lib/storage/config";
import { logger } from "@/lib/logger";
import { copyDirectory, copyKey, deleteKeys, dirOf, isPrivateKey, keyOf, newPrivateMediaDir, newPublicThumbKey, PUBLIC_HLS_PREFIX } from "@/lib/media/private-media";
import { mediaPrivatePrefix } from "@/lib/media/stream-proxy";

export const MOVIES_MEDIA_VERTICAL = "movies";

export type PrivatizeOutcome = "moved" | "thumb_fixed" | "already" | "not_ready" | "external" | "unconfigured" | "missing";

type VideoMediaRow = { id: string; playback_url: string | null; thumbnail_url: string | null };

async function loadVideo(videoId: string): Promise<VideoMediaRow | null> {
    const { rows } = await dbQuery<VideoMediaRow>(`SELECT id::text, playback_url, thumbnail_url FROM videos WHERE id = $1`, [videoId]);
    return rows[0] ?? null;
}

/** Thumbnail-ul trebuie mutat dacă e în prefixul privat sau într-un director HLS (dezvăluie calea). */
function thumbNeedsMove(thumbKey: string | null, hlsDir: string): boolean {
    if (!thumbKey) return false;
    return isPrivateKey(thumbKey) || thumbKey.startsWith(hlsDir) || thumbKey.startsWith(PUBLIC_HLS_PREFIX);
}

/** Copia publică aleatoare a thumbnail-ului; null dacă sursa nu mai există (mai bine fără copertă decât cu calea). */
async function relocateThumb(thumbKey: string): Promise<string | null> {
    const to = newPublicThumbKey(MOVIES_MEDIA_VERTICAL);
    try {
        await copyKey(thumbKey, to);
        return mediaPublicUrl(to);
    } catch (err) {
        logger.warn({ err, thumbKey }, "[movies] thumbnail copy failed — cleared");
        return null;
    }
}

async function privatize(videoId: string): Promise<PrivatizeOutcome> {
    const v = await loadVideo(videoId);
    if (!v) return "missing";
    if (!v.playback_url) return "not_ready";
    const key = keyOf(v.playback_url);
    if (!key) return "external";
    const thumbKey = keyOf(v.thumbnail_url);

    if (isPrivateKey(key)) {
        if (!thumbNeedsMove(thumbKey, dirOf(key))) return "already";
        const thumbUrl = await relocateThumb(thumbKey!);
        await dbQuery(`UPDATE videos SET thumbnail_url = $2, updated_at = now() WHERE id = $1`, [videoId, thumbUrl]);
        return "thumb_fixed";
    }

    const fromDir = dirOf(key);
    const toDir = newPrivateMediaDir(MOVIES_MEDIA_VERTICAL);
    const copied = await copyDirectory(fromDir, toDir);
    if (!copied.includes(key)) throw new Error("movies_privatize_master_missing");
    const thumbUrl = thumbNeedsMove(thumbKey, fromDir) ? await relocateThumb(thumbKey!) : v.thumbnail_url;
    await dbQuery(
        `UPDATE videos
            SET playback_url = $2, thumbnail_url = $3,
                metadata = (COALESCE(metadata, '{}'::jsonb) - 'preview_url' - 'audio_url') || jsonb_build_object('media_private_at', now()),
                updated_at = now()
          WHERE id = $1 AND playback_url = $4`,
        [videoId, mediaPublicUrl(`${toDir}${key.slice(fromDir.length)}`), thumbUrl, v.playback_url],
    );
    // Copiile publice dispar abia după ce DB-ul indică noul director.
    await deleteKeys(copied);
    logger.info({ videoId, objects: copied.length }, "[movies] paid episode media moved to the private prefix");
    return "moved";
}

/** Idempotent; două apeluri paralele pe același video se serializează (advisory lock). */
export async function ensureEpisodeMediaPrivate(videoId: string): Promise<PrivatizeOutcome> {
    if (!isStorageConfigured()) return "unconfigured";
    return withAdvisoryLock(`movies:privatize:${videoId}`, () => privatize(videoId));
}

/** Rândurile ce încă trebuie reparate: episoade plătite cu media publică sau thumbnail în prefixul privat/HLS. */
export async function listPaidEpisodesNeedingPrivacy(opts: { seriesId?: string; limit: number }): Promise<string[]> {
    const priv = `%/${mediaPrivatePrefix()}%`;
    const params: unknown[] = [priv, opts.limit];
    if (opts.seriesId) params.push(opts.seriesId);
    const { rows } = await dbQuery<{ video_id: string }>(
        `SELECT e.video_id::text AS video_id
           FROM movie_episodes e
           JOIN movie_series s ON s.id = e.series_id
           JOIN videos v ON v.id = e.video_id
          WHERE e.episode_number > s.free_episodes
            AND v.playback_url IS NOT NULL
            AND (v.playback_url NOT LIKE $1 OR v.thumbnail_url LIKE $1 OR v.thumbnail_url LIKE '%/videos/hls/%')
            ${opts.seriesId ? `AND s.id = $3` : ``}
          ORDER BY e.created_at
          LIMIT $2`,
        params,
    );
    return rows.map((r) => r.video_id);
}

export type PrivatizeReport = { checked: number; moved: number; fixed: number; failed: number; skipped: number };

/**
 * Trece prin episoadele plătite care încă au media publică. Idempotent: o a
 * doua rulare nu mai găsește nimic. `dryRun` doar numără.
 */
export async function privatizePaidEpisodeMedia(opts: { seriesId?: string; limit?: number; dryRun?: boolean } = {}): Promise<PrivatizeReport> {
    const report: PrivatizeReport = { checked: 0, moved: 0, fixed: 0, failed: 0, skipped: 0 };
    if (!isStorageConfigured()) return report;
    const ids = await listPaidEpisodesNeedingPrivacy({ seriesId: opts.seriesId, limit: opts.limit ?? 200 });
    report.checked = ids.length;
    if (opts.dryRun) return report;
    for (const id of ids) {
        try {
            const out = await ensureEpisodeMediaPrivate(id);
            if (out === "moved") report.moved++;
            else if (out === "thumb_fixed") report.fixed++;
            else report.skipped++;
        } catch (err) {
            report.failed++;
            logger.error({ err, videoId: id }, "[movies] privatizing paid episode media failed");
        }
    }
    return report;
}

/** Varianta „best effort" după scrieri în DB: nu aruncă (cron-ul și ruta play reiau). */
export async function privatizeSeriesMediaSafely(seriesId: string): Promise<void> {
    try {
        const r = await privatizePaidEpisodeMedia({ seriesId });
        if (r.failed) logger.error({ seriesId, ...r }, "[movies] some paid episodes are still in the public prefix");
    } catch (err) {
        logger.error({ err, seriesId }, "[movies] privatize after series change failed");
    }
}
