/**
 * Publicarea unei piese și sincronizarea ei cu `audio_tracks` (sunetele din
 * reels). O piesă publicată, gratuită și cu `allow_reels` primește un rând
 * `audio_tracks` cu `source='swypik_music'`; piesele premium sau cu reels
 * oprite nu devin niciodată sunet public — dacă aveau unul, îl dezactivăm.
 */
import { withTransaction, type TxQuery } from "@/lib/db";
import { isCommercialLicense } from "@/lib/audio/license";
import { MUSIC_AUDIO_TRACK_LICENSE, MUSIC_AUDIO_TRACK_SOURCE } from "./config";
import { TRACK_COLS, buildTrackUpdate, normalizeTrackRow, type TrackPatch } from "./repository";
import type { MusicArtistRow, MusicTrackRow } from "./types";

export type AudioTrackInsert = {
    source: typeof MUSIC_AUDIO_TRACK_SOURCE;
    source_id: string;
    title: string;
    artist: string;
    duration_s: number;
    audio_url: string;
    preview_url: string | null;
    image_url: string | null;
    genre: string;
    license: string;
    attribution_url: string;
    is_active: true;
};

type SoundSource = Pick<MusicTrackRow, "id" | "title" | "genre" | "duration_ms" | "public_url" | "cover_url" | "is_premium" | "allow_reels">;
type SoundArtist = Pick<MusicArtistRow, "stage_name" | "slug">;

/** Rândul `audio_tracks` pentru o piesă, sau `null` când piesa nu poate fi sunet public. Pur. */
export function audioTrackRowFor(track: SoundSource, artist: SoundArtist): AudioTrackInsert | null {
    if (track.is_premium || !track.allow_reels || !track.public_url) return null;
    return {
        source: MUSIC_AUDIO_TRACK_SOURCE,
        source_id: track.id,
        title: track.title,
        artist: artist.stage_name,
        duration_s: Math.max(1, Math.round(track.duration_ms / 1000)),
        audio_url: track.public_url,
        preview_url: null,
        image_url: track.cover_url,
        genre: track.genre,
        license: MUSIC_AUDIO_TRACK_LICENSE,
        attribution_url: `/music/artist/${artist.slug}`,
        is_active: true,
    };
}

/**
 * Aliniază `audio_tracks` cu starea piesei, în tranzacția apelantului:
 * upsert + reactivare când piesa poate fi sunet, dezactivare altfel.
 * Întoarce id-ul sunetului legat de piesă (sau null dacă nu există).
 */
export async function syncAudioTrack(q: TxQuery, track: MusicTrackRow, artist: SoundArtist): Promise<number | null> {
    const row = track.status === "published" ? audioTrackRowFor(track, artist) : null;
    if (row) {
        const { rows } = await q<{ id: number }>(
            `INSERT INTO audio_tracks (source, source_id, title, artist, duration_s, audio_url, preview_url, image_url, genre, license, attribution_url, licensed_for_commercial, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
             ON CONFLICT (source, source_id) DO UPDATE SET
                 title = EXCLUDED.title, artist = EXCLUDED.artist, duration_s = EXCLUDED.duration_s,
                 audio_url = EXCLUDED.audio_url, image_url = EXCLUDED.image_url, genre = EXCLUDED.genre,
                 license = EXCLUDED.license, attribution_url = EXCLUDED.attribution_url,
                 licensed_for_commercial = EXCLUDED.licensed_for_commercial, is_active = true, updated_at = now()
             RETURNING id::int AS id`,
            [row.source, row.source_id, row.title, row.artist, row.duration_s, row.audio_url, row.preview_url, row.image_url, row.genre, row.license, row.attribution_url, isCommercialLicense(row.license)],
        );
        const id = rows[0].id;
        await q(`UPDATE music_tracks SET audio_track_id = $2, updated_at = now() WHERE id = $1`, [track.id, id]);
        return id;
    }
    if (track.audio_track_id !== null) {
        await q(`UPDATE audio_tracks SET is_active = false, updated_at = now() WHERE id = $1`, [track.audio_track_id]);
    }
    return track.audio_track_id;
}

export type PublishResult =
    | { ok: true; track: MusicTrackRow }
    | { ok: false; reason: "not_found" | "not_approved" };

async function lockTrackWithArtist(q: TxQuery, trackId: string): Promise<{ track: MusicTrackRow; artist: MusicArtistRow } | null> {
    const { rows } = await q<MusicTrackRow & { price_units: string | null; price_cents: string | null }>(
        `SELECT ${TRACK_COLS} FROM music_tracks WHERE id = $1 FOR UPDATE`,
        [trackId],
    );
    const raw = rows[0];
    if (!raw) return null;
    const track = {
        ...raw,
        price_units: raw.price_units === null ? null : Number(raw.price_units),
        price_cents: raw.price_cents === null ? null : Number(raw.price_cents),
    };
    const { rows: artists } = await q<MusicArtistRow>(`SELECT * FROM music_artists WHERE user_id = $1`, [track.artist_user_id]);
    if (!artists[0]) return null;
    return { track, artist: artists[0] };
}

/** Publică o piesă aprobată la moderare și îi creează/reactivează sunetul pentru reels. */
export async function publishTrack(trackId: string): Promise<PublishResult> {
    return withTransaction(async (q) => {
        const found = await lockTrackWithArtist(q, trackId);
        if (!found) return { ok: false, reason: "not_found" };
        if (found.track.moderation_status !== "approved") return { ok: false, reason: "not_approved" };
        await q(
            `UPDATE music_tracks SET status = 'published', published_at = COALESCE(published_at, now()), updated_at = now() WHERE id = $1`,
            [trackId],
        );
        const published: MusicTrackRow = { ...found.track, status: "published", published_at: found.track.published_at ?? new Date().toISOString() };
        const audioTrackId = await syncAudioTrack(q, published, found.artist);
        return { ok: true, track: { ...published, audio_track_id: audioTrackId } };
    });
}

/** Arhivează o piesă (artistul propriu sau admin) și îi dezactivează sunetul. */
export async function archiveTrack(trackId: string, artistUserId: string | null): Promise<MusicTrackRow | null> {
    return withTransaction(async (q) => {
        const found = await lockTrackWithArtist(q, trackId);
        if (!found) return null;
        if (artistUserId && found.track.artist_user_id !== artistUserId) return null;
        await q(`UPDATE music_tracks SET status = 'archived', updated_at = now() WHERE id = $1`, [trackId]);
        const archived: MusicTrackRow = { ...found.track, status: "archived" };
        await syncAudioTrack(q, archived, found.artist);
        return archived;
    });
}

/**
 * După o modificare a piesei (premium / allow_reels / titlu / copertă) aliniază
 * sunetul cu noua stare. Se apelează în afara unei tranzacții existente.
 */
export async function resyncTrackSound(trackId: string): Promise<void> {
    await withTransaction(async (q) => {
        const found = await lockTrackWithArtist(q, trackId);
        if (found) await syncAudioTrack(q, found.track, found.artist);
    });
}

/**
 * Actualizare + aliniere `audio_tracks` în ACEEAȘI tranzacție (Review Focus
 * #3/#4): dacă sincronizarea eșuează, nici schimbarea de stare nu rămâne, deci
 * o piesă devenită premium / fără reels nu poate rămâne cu sunet activ.
 * `null` când piesa nu există sau nu e a artistului.
 */
export async function updateTrackAndSync(trackId: string, artistUserId: string | null, patch: TrackPatch): Promise<MusicTrackRow | null> {
    return withTransaction(async (q) => {
        const update = buildTrackUpdate(trackId, artistUserId, patch);
        if (!update) return null;
        const { rows } = await q<MusicTrackRow & { price_units: string | null; price_cents: string | null }>(update.text, update.params);
        if (!rows[0]) return null;
        const track = normalizeTrackRow(rows[0]);
        const { rows: artists } = await q<MusicArtistRow>(`SELECT * FROM music_artists WHERE user_id = $1`, [track.artist_user_id]);
        if (!artists[0]) return null;
        const audioTrackId = await syncAudioTrack(q, track, artists[0]);
        return { ...track, audio_track_id: audioTrackId };
    });
}
