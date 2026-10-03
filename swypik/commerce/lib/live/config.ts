/**
 * Swypik Live — limite și temporizări reglabile din env
 * (LIVE_<NUME>_LIMIT / _WINDOW, LIVE_NOTIFY_PUSH_MAX, LIVE_POLL_MS,
 * LIVE_HEARTBEAT_TTL, LIVE_HEARTBEAT_INTERVAL_MS …).
 */
import { isSfuConfigured } from "@/lib/realtime/config";
import type { RateLimitConfig } from "@/lib/security/rate-limit";
import { intEnv } from "@/lib/config/env";

function limit(key: string, defLimit: number, defWindow: number): RateLimitConfig {
  return { limit: intEnv(`LIVE_${key}_LIMIT`, defLimit, 1), window: intEnv(`LIVE_${key}_WINDOW`, defWindow, 1) };
}

export const LIVE_CONFIG = {
  /** Câți followeri primesc push la pornirea unui live (notificarea in-app o primesc toți). */
  get notifyPushMax() { return intEnv("LIVE_NOTIFY_PUSH_MAX", 500, 1); },
  /** Plasă de siguranță: cât de des își reîmprospătează clientul streamul (SSE face restul). */
  get viewerPollMs() { return intEnv("LIVE_POLL_MS", 15000, 1); },
  /** După câte secunde fără heartbeat de la gazdă streamul se încheie. */
  get heartbeatTtlSec() { return intEnv("LIVE_HEARTBEAT_TTL", 20, 1); },
  /** Cât de des trimit gazda și spectatorii heartbeat (trebuie < TTL). */
  get heartbeatIntervalMs() { return Math.min(intEnv("LIVE_HEARTBEAT_INTERVAL_MS", 7000, 1), intEnv("LIVE_HEARTBEAT_TTL", 20, 1) * 500); },
  /** Cât trăiește legătura sesiune SFU spectator → stream (pentru răspunsul SDP și heartbeat). */
  get viewerSessionTtlSec() { return intEnv("LIVE_VIEWER_SESSION_TTL", 6 * 3600, 1); },
  rate: {
    get hostPublish() { return limit("HOST_PUBLISH", 20, 60); },
    get viewerWatchIp() { return limit("VIEWER_WATCH_IP", 60, 60); },
    get heartbeatIp() { return limit("HEARTBEAT_IP", 600, 60); },
    get iceIp() { return limit("ICE_IP", 60, 60); },
    /** Vizitatori fără cont: fiecare /watch creează o sesiune SFU plătită → plafon strict per IP. */
    get viewerWatchAnonIp() { return limit("VIEWER_WATCH_ANON_IP", 6, 600); },
    /** Spectatori autentificați, per cont. */
    get viewerWatchUser() { return limit("VIEWER_WATCH_USER", 30, 600); },
    /** Deschideri SSE de chat per IP (reconectările EventSource intră aici). */
    get chatSseIp() { return limit("CHAT_SSE_IP", 30, 60); },
    /** Mesaje de chat per utilizator (toate streamurile). */
    get chatMessageUser() { return limit("CHAT_MESSAGE_USER", 5, 10); },
    /** Rapoarte + acțiuni de moderare per utilizator. */
    get chatModerationUser() { return limit("CHAT_MODERATION_USER", 20, 60); },
    /** Tips monetare: limită mică pentru dublu-tap/abuz, idempotența rămâne în DB. */
    get tipUser() { return limit("TIP_USER", 10, 60); },
  },
  /** Tip minim/maxim în bani RON. */
  get tipMinCents() { return intEnv("LIVE_TIP_MIN_CENTS", 100, 100, 50_000); },
  get tipMaxCents() {
    return Math.max(
      intEnv("LIVE_TIP_MIN_CENTS", 100, 100, 50_000),
      intEnv("LIVE_TIP_MAX_CENTS", 50_000, 100, 50_000),
    );
  },
  /** Plafon de sesiuni SFU spectator per stream (cost). */
  get maxViewersPerStream() { return intEnv("LIVE_MAX_VIEWERS_PER_STREAM", 5000, 1); },
  /** Gazda poate lipsi (app în fundal, rețea) atâtea secunde înainte ca streamul să se încheie. */
  get hostGraceSec() { return intEnv("LIVE_HOST_GRACE_SEC", 90, 1); },
} as const;

/**
 * Media Live funcționează doar cu SFU-ul Cloudflare configurat ȘI Redis
 * (heartbeat-uri, spectatori, fan-out). Altfel: 503 onest + mesaj în UI.
 */
export function isLiveMediaConfigured(): boolean {
  return isSfuConfigured() && Boolean(process.env.REDIS_URL?.trim());
}

/** Numele track-urilor publicate de gazdă (validate la publicare). */
export const LIVE_TRACK_NAMES = ["video", "audio"] as const;
export type LiveTrackName = (typeof LIVE_TRACK_NAMES)[number];
