/**
 * Parametrii Swypik Music. Toate valorile vin din env cu fallback explicit —
 * niciun număr magic în rute sau componente.
 */
import { intEnv } from "@/lib/config/env";

/** Cota artistului din fiecare deblocare sau tip, în basis points (7000 = 70 %). */
export const MUSIC_ARTIST_SHARE_BPS = intEnv("MUSIC_ARTIST_SHARE_BPS", 7000, 0, 10_000);
/** Reducere la deblocarea unui album întreg (procent din suma pieselor premium). */
export const MUSIC_ALBUM_DISCOUNT_PCT = intEnv("MUSIC_ALBUM_DISCOUNT_PCT", 30, 0, 90);
/** Coloană legacy, neutilizată: valoare fixă scrisă doar pt. constrângerea NOT NULL a schemei DB vechi (piese premium). */
export const MUSIC_TRACK_PRICE_MIN_UNITS = intEnv("MUSIC_TRACK_PRICE_MIN_UNITS", 100, 1, 1_000_000);
/** Preț piesă/album în RON (bani/cenți). Plată cu cardul (Stripe) — înlocuiește sistemul legacy de mai sus. */
export const MUSIC_TRACK_PRICE_MIN_CENTS = intEnv("MUSIC_TRACK_PRICE_MIN_CENTS", 100, 1, 10_000_000);
export const MUSIC_TRACK_PRICE_MAX_CENTS = intEnv("MUSIC_TRACK_PRICE_MAX_CENTS", 20_000, 1, 10_000_000);
export const MUSIC_DEFAULT_TRACK_PRICE_CENTS = intEnv("MUSIC_DEFAULT_TRACK_PRICE_CENTS", 300, 1, 10_000_000);
/** Upload: mărime și durată maxime; MVP acceptă M4A/MP3/AAC servite progresiv. */
export const MUSIC_MAX_UPLOAD_BYTES = intEnv("MUSIC_MAX_UPLOAD_MB", 40, 1, 500) * 1024 * 1024;
export const MUSIC_MAX_DURATION_MS = intEnv("MUSIC_MAX_DURATION_MIN", 30, 1, 240) * 60_000;
export const MUSIC_MIN_DURATION_MS = 5_000;
export const MUSIC_ALLOWED_MIME = ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac"] as const;
/** Valabilitatea token-ului de stream pentru piesele premium (secunde). */
export const MUSIC_STREAM_TOKEN_TTL_S = intEnv("MUSIC_STREAM_TOKEN_TTL_S", 900, 60, 3_600);
/** Un play per (IP, piesă) în această fereastră (secunde) — contorul nu poate fi umflat prin replay. */
export const MUSIC_PLAY_DEDUP_TTL_S = 600;
/** Pragul de la care o redare se numără ca play (secunde). */
export const MUSIC_PLAY_COUNT_AFTER_S = 30;
export const MUSIC_CATALOG_PAGE_SIZE = 30;
export const MUSIC_HOME_ROW_MAX = 20;
export const MUSIC_TOP_COUNT = 10;
/** Identitatea sunetelor Swypik Music în tabela partajată `audio_tracks`. */
export const MUSIC_AUDIO_TRACK_SOURCE = "swypik_music";
export const MUSIC_AUDIO_TRACK_LICENSE = "swypik-artist";
