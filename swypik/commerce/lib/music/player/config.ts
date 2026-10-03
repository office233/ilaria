/**
 * Parametrii player-ului audio (client). Fără numere magice în hook-uri/componente.
 */

/** Cât așteptăm evenimentul `playing` înainte să trecem la următorul URL al fluxului. */
export const STREAM_START_TIMEOUT_MS = 4_000;

/** Numărul maxim de `<link rel="preconnect">` pentru hosturi de stream ținute simultan în `<head>`. */
export const STREAM_PRECONNECT_MAX_LINKS = 6;

/** Numărul maxim de URL-uri încercate pentru un singur flux (principal + alternative). */
export const STREAM_MAX_CANDIDATES = 4;

/** Mărimea declarată a copertei în MediaSession (coperțile sunt pătrate). */
export const MEDIA_SESSION_ARTWORK_SIZE = "512x512";

/** Pasul seek-ului înainte/înapoi din MediaSession (căști, lock screen). */
export const MEDIA_SESSION_SEEK_STEP_MS = 10_000;

/** Cheia localStorage pentru volumul/mute-ul persistat al player-ului. */
export const MUSIC_VOLUME_STORAGE_KEY = "swypik_music_volume";
