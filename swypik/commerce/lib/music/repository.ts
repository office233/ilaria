import { dbQuery, withTransaction } from "@/lib/db";
import { MUSIC_AUDIO_TRACK_SOURCE } from "./config";
import type { ContentStatus, ModerationStatus, MusicAlbumRow, MusicArtistRow, MusicAudience, MusicTrackRow } from "./types";

export const ARTIST_COLS = `user_id, stage_name, slug, bio, avatar_url, cover_url, approved_at, created_at, updated_at`;
export const ALBUM_COLS = `id, artist_user_id, title, slug, cover_url, release_date::text AS release_date, status,
    price_units::text AS price_units, price_cents::text AS price_cents, created_at, updated_at`;
export const TRACK_COLS = `id, artist_user_id, album_id, track_number, title, slug, cover_url, genre, duration_ms, explicit,
    object_key, public_url, is_premium, price_units::text AS price_units, price_cents::text AS price_cents, allow_reels, audio_track_id::int AS audio_track_id,
    audience, status, moderation_status, license_note, published_at, created_at, updated_at`;

const prefixed = (cols: string, alias: string) => cols.split(",").map((c) => `${alias}.${c.trim()}`).join(", ");
const TRACK_COLS_T = prefixed(TRACK_COLS, "t");
const ALBUM_COLS_AL = prefixed(ALBUM_COLS, "al");

/** Coloanele artistului ca JSON (pentru JOIN-uri) — același obiect ca `MusicArtistRow`. */
const ARTIST_JSON = `json_build_object('user_id', a.user_id, 'stage_name', a.stage_name, 'slug', a.slug, 'bio', a.bio,
    'avatar_url', a.avatar_url, 'cover_url', a.cover_url, 'approved_at', a.approved_at, 'created_at', a.created_at,
    'updated_at', a.updated_at) AS artist`;

export type TrackWithArtist = MusicTrackRow & { artist: MusicArtistRow };
export type TrackListItem = TrackWithArtist & { plays_7d: number };
export type AlbumWithArtist = MusicAlbumRow & { artist: MusicArtistRow; track_count: number };

type RawTrack = Omit<MusicTrackRow, "price_units" | "price_cents"> & { price_units: string | null; price_cents: string | null };
type RawAlbum = Omit<MusicAlbumRow, "price_units" | "price_cents"> & { price_units: string | null; price_cents: string | null };

function normalizeTrack<T extends RawTrack>(row: T): Omit<T, "price_units" | "price_cents"> & { price_units: number | null; price_cents: number | null } {
    return {
        ...row,
        price_units: row.price_units === null ? null : Number(row.price_units),
        price_cents: row.price_cents === null ? null : Number(row.price_cents),
    };
}
function normalizeAlbum<T extends RawAlbum>(row: T): Omit<T, "price_units" | "price_cents"> & { price_units: number | null; price_cents: number | null } {
    return {
        ...row,
        price_units: row.price_units === null ? null : Number(row.price_units),
        price_cents: row.price_cents === null ? null : Number(row.price_cents),
    };
}

// ── Artiști ──────────────────────────────────────────────────────────────

export async function getArtistBySlug(slug: string): Promise<MusicArtistRow | null> {
    const { rows } = await dbQuery<MusicArtistRow>(`SELECT ${ARTIST_COLS} FROM music_artists WHERE slug = $1`, [slug]);
    return rows[0] ?? null;
}

export async function getArtistByUserId(userId: string): Promise<MusicArtistRow | null> {
    const { rows } = await dbQuery<MusicArtistRow>(`SELECT ${ARTIST_COLS} FROM music_artists WHERE user_id = $1`, [userId]);
    return rows[0] ?? null;
}

export async function isArtist(userId: string): Promise<boolean> {
    const { rows } = await dbQuery(`SELECT 1 FROM music_artists WHERE user_id = $1`, [userId]);
    return rows.length > 0;
}

export type UpsertArtistInput = { userId: string; stageName: string; slug: string; bio: string; avatarUrl: string | null; coverUrl: string | null; approvedBy: string | null };

/** Aprobare/actualizare artist. Slug-ul rămâne cel inițial (link-urile nu se rup). */
export async function upsertArtist(i: UpsertArtistInput): Promise<MusicArtistRow> {
    const { rows } = await dbQuery<MusicArtistRow>(
        `INSERT INTO music_artists (user_id, stage_name, slug, bio, avatar_url, cover_url, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE SET stage_name = EXCLUDED.stage_name, bio = EXCLUDED.bio,
             avatar_url = COALESCE(EXCLUDED.avatar_url, music_artists.avatar_url),
             cover_url = COALESCE(EXCLUDED.cover_url, music_artists.cover_url), updated_at = now()
         RETURNING ${ARTIST_COLS}`,
        [i.userId, i.stageName, i.slug, i.bio, i.avatarUrl, i.coverUrl, i.approvedBy],
    );
    return rows[0];
}

export async function listArtistsForAdmin() {
    const { rows } = await dbQuery<MusicArtistRow & { display_name: string | null; email: string | null; track_count: number }>(
        `SELECT ${prefixed(ARTIST_COLS, "a")}, u.display_name, u.email,
                (SELECT COUNT(*) FROM music_tracks t WHERE t.artist_user_id = a.user_id)::int AS track_count
           FROM music_artists a JOIN users u ON u.id = a.user_id
          ORDER BY a.approved_at DESC`,
    );
    return rows;
}

/** Retrage statutul de artist: piesele se arhivează, sunetele se dezactivează, rândul dispare. */
export async function removeArtist(userId: string): Promise<void> {
    await withTransaction(async (q) => {
        await q(`UPDATE music_tracks SET status = 'archived', updated_at = now() WHERE artist_user_id = $1`, [userId]);
        await q(
            `UPDATE audio_tracks SET is_active = false, updated_at = now()
              WHERE source = $2 AND source_id IN (SELECT id::text FROM music_tracks WHERE artist_user_id = $1)`,
            [userId, MUSIC_AUDIO_TRACK_SOURCE],
        );
        await q(`DELETE FROM music_artists WHERE user_id = $1`, [userId]);
    });
}

// ── Piese ────────────────────────────────────────────────────────────────

const PLAYS_7D = `(SELECT COALESCE(SUM(c.plays), 0) FROM music_play_counters c WHERE c.track_id = t.id AND c.day > current_date - 7)::int`;

export async function getTrackBySlug(slug: string): Promise<TrackWithArtist | null> {
    const { rows } = await dbQuery<RawTrack & { artist: MusicArtistRow }>(
        `SELECT ${TRACK_COLS_T}, ${ARTIST_JSON} FROM music_tracks t JOIN music_artists a ON a.user_id = t.artist_user_id WHERE t.slug = $1`,
        [slug],
    );
    return rows[0] ? normalizeTrack(rows[0]) : null;
}

export async function getTrackById(id: string): Promise<TrackWithArtist | null> {
    const { rows } = await dbQuery<RawTrack & { artist: MusicArtistRow }>(
        `SELECT ${TRACK_COLS_T}, ${ARTIST_JSON} FROM music_tracks t JOIN music_artists a ON a.user_id = t.artist_user_id WHERE t.id = $1`,
        [id],
    );
    return rows[0] ? normalizeTrack(rows[0]) : null;
}

export type ListTracksOpts = {
    sort: "trending" | "new";
    limit: number;
    offset: number;
    genre?: string;
    q?: string;
    artistUserId?: string;
    albumId?: string;
    audience?: MusicAudience;
};

/** Piesele publicate; trending = plays 7 zile + deblocări (ponderate), new = published_at. */
export async function listTracks(opts: ListTracksOpts): Promise<TrackListItem[]> {
    const params: unknown[] = [opts.limit, opts.offset];
    const where: string[] = [`t.status = 'published'`];
    const add = (clause: string, value: unknown) => { params.push(value); where.push(clause.replace("?", `$${params.length}`)); };
    if (opts.genre) add(`t.genre = ?`, opts.genre);
    if (opts.artistUserId) add(`t.artist_user_id = ?`, opts.artistUserId);
    if (opts.albumId) add(`t.album_id = ?`, opts.albumId);
    if (opts.audience) add(`t.audience = ?`, opts.audience);
    if (opts.q) add(`(t.title ILIKE ? OR a.stage_name ILIKE $${params.length + 1})`, `%${opts.q}%`);
    const order = opts.sort === "new"
        ? `t.published_at DESC NULLS LAST`
        : `${PLAYS_7D}
           + 10 * (SELECT COUNT(*) FROM music_unlocks u WHERE u.track_id = t.id AND u.created_at > now() - interval '7 days') DESC,
           t.published_at DESC`;
    const { rows } = await dbQuery<RawTrack & { artist: MusicArtistRow; plays_7d: number }>(
        `SELECT ${TRACK_COLS_T}, ${ARTIST_JSON}, ${PLAYS_7D} AS plays_7d
           FROM music_tracks t JOIN music_artists a ON a.user_id = t.artist_user_id
          WHERE ${where.join(" AND ")}
          ORDER BY ${order}
          LIMIT $1 OFFSET $2`,
        params,
    );
    return rows.map(normalizeTrack);
}

/** Piesele unui artist (studio: toate; public: doar publicate), cu plays pe 7 zile. */
export async function listArtistTracks(artistUserId: string, publishedOnly: boolean): Promise<TrackListItem[]> {
    const { rows } = await dbQuery<RawTrack & { artist: MusicArtistRow; plays_7d: number }>(
        `SELECT ${TRACK_COLS_T}, ${ARTIST_JSON}, ${PLAYS_7D} AS plays_7d
           FROM music_tracks t JOIN music_artists a ON a.user_id = t.artist_user_id
          WHERE t.artist_user_id = $1 ${publishedOnly ? `AND t.status = 'published'` : ""}
          ORDER BY t.published_at DESC NULLS LAST, t.created_at DESC`,
        [artistUserId],
    );
    return rows.map(normalizeTrack);
}

export async function listAlbumTracks(albumId: string, publishedOnly: boolean): Promise<TrackListItem[]> {
    const { rows } = await dbQuery<RawTrack & { artist: MusicArtistRow; plays_7d: number }>(
        `SELECT ${TRACK_COLS_T}, ${ARTIST_JSON}, ${PLAYS_7D} AS plays_7d
           FROM music_tracks t JOIN music_artists a ON a.user_id = t.artist_user_id
          WHERE t.album_id = $1 ${publishedOnly ? `AND t.status = 'published'` : ""}
          ORDER BY t.track_number ASC NULLS LAST, t.created_at ASC`,
        [albumId],
    );
    return rows.map(normalizeTrack);
}

export async function listTracksForAdmin(status?: ContentStatus): Promise<TrackWithArtist[]> {
    const params: unknown[] = [];
    if (status) params.push(status);
    const { rows } = await dbQuery<RawTrack & { artist: MusicArtistRow }>(
        `SELECT ${TRACK_COLS_T}, ${ARTIST_JSON}
           FROM music_tracks t JOIN music_artists a ON a.user_id = t.artist_user_id
          ${status ? "WHERE t.status = $1" : ""}
          ORDER BY t.created_at DESC LIMIT 200`,
        params,
    );
    return rows.map(normalizeTrack);
}

export type CreateTrackInput = {
    id: string;
    artistUserId: string;
    albumId: string | null;
    trackNumber: number | null;
    title: string;
    slug: string;
    coverUrl: string | null;
    genre: string;
    durationMs: number;
    explicit: boolean;
    objectKey: string;
    publicUrl: string | null;
    isPremium: boolean;
    /** Legacy — nu mai e editabil din UI; păstrat doar pt. constrângerea premium a coloanei vechi. */
    priceUnits: number | null;
    /** Preț RON (cenți). `null` = „preț în curând" (chiar dacă piesa e premium). */
    priceCents: number | null;
    allowReels: boolean;
    audience: MusicAudience;
    licenseNote: string;
};

export async function createTrack(i: CreateTrackInput): Promise<MusicTrackRow> {
    const { rows } = await dbQuery<RawTrack>(
        `INSERT INTO music_tracks (id, artist_user_id, album_id, track_number, title, slug, cover_url, genre, duration_ms, explicit,
                                   object_key, public_url, is_premium, price_units, price_cents, allow_reels, audience, status, license_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'pending_review', $18)
         RETURNING ${TRACK_COLS}`,
        [i.id, i.artistUserId, i.albumId, i.trackNumber, i.title, i.slug, i.coverUrl, i.genre, i.durationMs, i.explicit,
         i.objectKey, i.publicUrl, i.isPremium, i.priceUnits, i.priceCents, i.allowReels, i.audience, i.licenseNote],
    );
    return normalizeTrack(rows[0]);
}

export type TrackPatch = Partial<{
    title: string;
    genre: string;
    explicit: boolean;
    isPremium: boolean;
    priceUnits: number | null;
    priceCents: number | null;
    publicUrl: string | null;
    allowReels: boolean;
    audience: MusicAudience;
    coverUrl: string | null;
    albumId: string | null;
    trackNumber: number | null;
    status: ContentStatus;
    moderationStatus: ModerationStatus;
    licenseNote: string | null;
}>;

const TRACK_PATCH_COLS: Record<keyof TrackPatch, string> = {
    title: "title",
    genre: "genre",
    explicit: "explicit",
    isPremium: "is_premium",
    priceUnits: "price_units",
    priceCents: "price_cents",
    publicUrl: "public_url",
    allowReels: "allow_reels",
    audience: "audience",
    coverUrl: "cover_url",
    albumId: "album_id",
    trackNumber: "track_number",
    status: "status",
    moderationStatus: "moderation_status",
    licenseNote: "license_note",
};

/**
 * UPDATE-ul parțial ca text + parametri (coloane din lista albă), refolosit și
 * în tranzacțiile din `publish.ts`. `null` când patch-ul nu schimbă nimic.
 */
export function buildTrackUpdate(id: string, artistUserId: string | null, patch: TrackPatch): { text: string; params: unknown[] } | null {
    const sets: string[] = [];
    const params: unknown[] = [id, artistUserId];
    for (const key of Object.keys(TRACK_PATCH_COLS) as (keyof TrackPatch)[]) {
        const value = patch[key];
        if (value === undefined) continue;
        params.push(value);
        sets.push(`${TRACK_PATCH_COLS[key]} = $${params.length}`);
    }
    if (!sets.length) return null;
    return {
        text: `UPDATE music_tracks SET ${sets.join(", ")}, updated_at = now()
          WHERE id = $1 AND ($2::uuid IS NULL OR artist_user_id = $2)
          RETURNING ${TRACK_COLS}`,
        params,
    };
}

export function normalizeTrackRow<T extends RawTrack>(row: T): Omit<T, "price_units" | "price_cents"> & { price_units: number | null; price_cents: number | null } {
    return normalizeTrack(row);
}

/** Actualizare parțială; cu `artistUserId` doar piesele proprii (admin: null). */
export async function updateTrack(id: string, artistUserId: string | null, patch: TrackPatch): Promise<MusicTrackRow | null> {
    const update = buildTrackUpdate(id, artistUserId, patch);
    if (!update) return getTrackById(id);
    const { rows } = await dbQuery<RawTrack>(update.text, update.params);
    return rows[0] ? normalizeTrack(rows[0]) : null;
}

// ── Albume ───────────────────────────────────────────────────────────────

export async function getAlbumBySlug(slug: string): Promise<AlbumWithArtist | null> {
    const { rows } = await dbQuery<RawAlbum & { artist: MusicArtistRow; track_count: number }>(
        `SELECT ${ALBUM_COLS_AL}, ${ARTIST_JSON},
                (SELECT COUNT(*) FROM music_tracks t WHERE t.album_id = al.id AND t.status = 'published')::int AS track_count
           FROM music_albums al JOIN music_artists a ON a.user_id = al.artist_user_id WHERE al.slug = $1`,
        [slug],
    );
    return rows[0] ? normalizeAlbum(rows[0]) : null;
}

export async function getAlbumById(id: string): Promise<AlbumWithArtist | null> {
    const { rows } = await dbQuery<RawAlbum & { artist: MusicArtistRow; track_count: number }>(
        `SELECT ${ALBUM_COLS_AL}, ${ARTIST_JSON},
                (SELECT COUNT(*) FROM music_tracks t WHERE t.album_id = al.id AND t.status = 'published')::int AS track_count
           FROM music_albums al JOIN music_artists a ON a.user_id = al.artist_user_id WHERE al.id = $1`,
        [id],
    );
    return rows[0] ? normalizeAlbum(rows[0]) : null;
}

export async function listArtistAlbums(artistUserId: string, publishedOnly: boolean): Promise<AlbumWithArtist[]> {
    const { rows } = await dbQuery<RawAlbum & { artist: MusicArtistRow; track_count: number }>(
        `SELECT ${ALBUM_COLS_AL}, ${ARTIST_JSON},
                (SELECT COUNT(*) FROM music_tracks t WHERE t.album_id = al.id AND t.status = 'published')::int AS track_count
           FROM music_albums al JOIN music_artists a ON a.user_id = al.artist_user_id
          WHERE al.artist_user_id = $1 ${publishedOnly ? `AND al.status = 'published'` : ""}
          ORDER BY al.release_date DESC NULLS LAST, al.created_at DESC`,
        [artistUserId],
    );
    return rows.map(normalizeAlbum);
}

export type CreateAlbumInput = {
    artistUserId: string;
    title: string;
    slug: string;
    coverUrl: string | null;
    releaseDate: string | null;
    priceUnits: number | null;
    priceCents: number | null;
};

/** Albumele se publică odată cu prima piesă publicată din ele (status urmărit de artist). */
export async function createAlbum(i: CreateAlbumInput): Promise<MusicAlbumRow> {
    const { rows } = await dbQuery<RawAlbum>(
        `INSERT INTO music_albums (artist_user_id, title, slug, cover_url, release_date, price_units, price_cents, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'published') RETURNING ${ALBUM_COLS}`,
        [i.artistUserId, i.title, i.slug, i.coverUrl, i.releaseDate, i.priceUnits, i.priceCents],
    );
    return normalizeAlbum(rows[0]);
}

export async function ownsAlbum(albumId: string, artistUserId: string): Promise<boolean> {
    const { rows } = await dbQuery(`SELECT 1 FROM music_albums WHERE id = $1 AND artist_user_id = $2`, [albumId, artistUserId]);
    return rows.length > 0;
}

// ── Viewer: deblocări, „Îmi plac" ────────────────────────────────────────

export async function getViewerUnlocks(userId: string): Promise<{ trackIds: Set<string>; albumIds: Set<string> }> {
    const { rows } = await dbQuery<{ track_id: string | null; album_id: string | null }>(
        `SELECT track_id, album_id FROM music_unlocks WHERE user_id = $1 AND status = 'paid'`,
        [userId],
    );
    const trackIds = new Set<string>();
    const albumIds = new Set<string>();
    for (const r of rows) {
        if (r.track_id) trackIds.add(r.track_id);
        if (r.album_id) albumIds.add(r.album_id);
    }
    return { trackIds, albumIds };
}

export async function getLikedTrackIds(userId: string, trackIds: readonly string[]): Promise<Set<string>> {
    if (!trackIds.length) return new Set();
    const { rows } = await dbQuery<{ track_id: string }>(
        `SELECT i.track_id FROM music_playlist_items i JOIN music_playlists p ON p.id = i.playlist_id
          WHERE p.user_id = $1 AND p.is_liked_list AND i.track_id = ANY($2::uuid[])`,
        [userId, trackIds],
    );
    return new Set(rows.map((r) => r.track_id));
}

// ── Plays și câștiguri ───────────────────────────────────────────────────

export async function incrementPlay(trackId: string): Promise<void> {
    await dbQuery(
        `INSERT INTO music_play_counters (track_id, day, plays) VALUES ($1, current_date, 1)
         ON CONFLICT (track_id, day) DO UPDATE SET plays = music_play_counters.plays + 1`,
        [trackId],
    );
}

export type ArtistEarnings = { unlock_units: number; unlocks_count: number };

/**
 * Câștigurile artistului: suma (cenți RON) e calculată DOAR din deblocările
 * plătite cu cardul (Stripe) — `payment_intent_id IS NOT NULL AND status = 'paid'`.
 * Deblocările legacy din era SWYP (fără plată cu cardul) nu intră în sumă,
 * dar contează în continuare la `unlocks_count` (statistica de "câte deblocări").
 * Tips-urile au fost eliminate — nu mai există sursă separată de câștiguri.
 */
export async function artistEarnings(artistUserId: string): Promise<ArtistEarnings> {
    const { rows } = await dbQuery<{ unlock_units: string; unlocks_count: string }>(
        `SELECT
            (SELECT COALESCE(SUM(u.artist_share_units), 0) FROM music_unlocks u
              LEFT JOIN music_tracks t ON t.id = u.track_id LEFT JOIN music_albums al ON al.id = u.album_id
             WHERE COALESCE(t.artist_user_id, al.artist_user_id) = $1
               AND u.payment_intent_id IS NOT NULL AND u.status = 'paid')::text AS unlock_units,
            (SELECT COUNT(*) FROM music_unlocks u
              LEFT JOIN music_tracks t ON t.id = u.track_id LEFT JOIN music_albums al ON al.id = u.album_id
             WHERE COALESCE(t.artist_user_id, al.artist_user_id) = $1
               AND u.status = 'paid')::text AS unlocks_count`,
        [artistUserId],
    );
    const r = rows[0];
    return { unlock_units: Number(r.unlock_units), unlocks_count: Number(r.unlocks_count) };
}

/** Câte clipuri folosesc sunetele artistului (videos.audio_track_id). */
export async function countReelsUsingArtist(artistUserId: string): Promise<number> {
    const { rows } = await dbQuery<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM videos v
          WHERE v.audio_track_id IN (SELECT audio_track_id FROM music_tracks WHERE artist_user_id = $1 AND audio_track_id IS NOT NULL)`,
        [artistUserId],
    );
    return Number(rows[0]?.count ?? 0);
}

// ── Playlist-uri ─────────────────────────────────────────────────────────

export type PlaylistRow = { id: string; user_id: string; title: string; is_liked_list: boolean; created_at: string };
export type PlaylistWithCount = PlaylistRow & { track_count: number };

export async function ensureLikedPlaylist(userId: string): Promise<string> {
    const { rows } = await dbQuery<{ id: string }>(
        `INSERT INTO music_playlists (user_id, title, is_liked_list) VALUES ($1, '', true)
         ON CONFLICT (user_id) WHERE is_liked_list DO UPDATE SET user_id = EXCLUDED.user_id RETURNING id`,
        [userId],
    );
    return rows[0].id;
}

export async function listPlaylists(userId: string): Promise<PlaylistWithCount[]> {
    const { rows } = await dbQuery<PlaylistWithCount>(
        `SELECT p.id, p.user_id, p.title, p.is_liked_list, p.created_at,
                (SELECT COUNT(*) FROM music_playlist_items i WHERE i.playlist_id = p.id)::int AS track_count
           FROM music_playlists p WHERE p.user_id = $1 ORDER BY p.is_liked_list DESC, p.created_at ASC`,
        [userId],
    );
    return rows;
}

export async function getPlaylist(id: string, userId: string): Promise<PlaylistRow | null> {
    const { rows } = await dbQuery<PlaylistRow>(`SELECT id, user_id, title, is_liked_list, created_at FROM music_playlists WHERE id = $1 AND user_id = $2`, [id, userId]);
    return rows[0] ?? null;
}

export async function createPlaylist(userId: string, title: string): Promise<PlaylistRow> {
    const { rows } = await dbQuery<PlaylistRow>(
        `INSERT INTO music_playlists (user_id, title) VALUES ($1, $2) RETURNING id, user_id, title, is_liked_list, created_at`,
        [userId, title],
    );
    return rows[0];
}

export async function renamePlaylist(id: string, userId: string, title: string): Promise<boolean> {
    const { rowCount } = await dbQuery(`UPDATE music_playlists SET title = $3 WHERE id = $1 AND user_id = $2 AND NOT is_liked_list`, [id, userId, title]);
    return (rowCount ?? 0) > 0;
}

export async function deletePlaylist(id: string, userId: string): Promise<boolean> {
    const { rowCount } = await dbQuery(`DELETE FROM music_playlists WHERE id = $1 AND user_id = $2 AND NOT is_liked_list`, [id, userId]);
    return (rowCount ?? 0) > 0;
}

export async function addToPlaylist(playlistId: string, trackId: string): Promise<void> {
    await dbQuery(
        `INSERT INTO music_playlist_items (playlist_id, track_id, position)
         VALUES ($1, $2, (SELECT COALESCE(MAX(position), 0) + 1 FROM music_playlist_items WHERE playlist_id = $1))
         ON CONFLICT DO NOTHING`,
        [playlistId, trackId],
    );
}

export async function removeFromPlaylist(playlistId: string, trackId: string): Promise<void> {
    await dbQuery(`DELETE FROM music_playlist_items WHERE playlist_id = $1 AND track_id = $2`, [playlistId, trackId]);
}

export async function listPlaylistTracks(playlistId: string): Promise<TrackListItem[]> {
    const { rows } = await dbQuery<RawTrack & { artist: MusicArtistRow; plays_7d: number }>(
        `SELECT ${TRACK_COLS_T}, ${ARTIST_JSON}, ${PLAYS_7D} AS plays_7d
           FROM music_playlist_items i
           JOIN music_tracks t ON t.id = i.track_id
           JOIN music_artists a ON a.user_id = t.artist_user_id
          WHERE i.playlist_id = $1 AND t.status = 'published'
          ORDER BY i.position ASC, i.added_at ASC`,
        [playlistId],
    );
    return rows.map(normalizeTrack);
}
