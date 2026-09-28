/**
 * Swypik Live — limite și temporizări reglabile din env
 * (LIVE_<NUME>_LIMIT / _WINDOW, LIVE_NOTIFY_PUSH_MAX, LIVE_POLL_MS,
 * LIVE_HEARTBEAT_TTL, LIVE_HEARTBEAT_INTERVAL_MS …).
 */
import { isSfuConfigured } from "@/lib/realtime/config";
import type { RateLimitConfig } from "@/lib/security/rate-limit";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function limit(key: string, defLimit: number, defWindow: number): RateLimitConfig {
  return { limit: envInt(`LIVE_${key}_LIMIT`, defLimit), window: envInt(`LIVE_${key}_WINDOW`, defWindow) };
}

export const LIVE_CONFIG = {
  /** Câți followeri primesc push la pornirea unui live (notificarea in-app o primesc toți). */
  get notifyPushMax() { return envInt("LIVE_NOTIFY_PUSH_MAX", 500); },
  /** Plasă de siguranță: cât de des își reîmprospătează clientul streamul (SSE face restul). */
  get viewerPollMs() { return envInt("LIVE_POLL_MS", 15000); },
  /** După câte secunde fără heartbeat de la gazdă streamul se încheie. */
  get heartbeatTtlSec() { return envInt("LIVE_HEARTBEAT_TTL", 20); },
  /** Cât de des trimit gazda și spectatorii heartbeat (trebuie < TTL). */
  get heartbeatIntervalMs() { return Math.min(envInt("LIVE_HEARTBEAT_INTERVAL_MS", 7000), envInt("LIVE_HEARTBEAT_TTL", 20) * 500); },
  /** Cât trăiește legătura sesiune SFU spectator → stream (pentru răspunsul SDP și heartbeat). */
  get viewerSessionTtlSec() { return envInt("LIVE_VIEWER_SESSION_TTL", 6 * 3600); },
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
  },
  /** Plafon de sesiuni SFU spectator per stream (cost). */
  get maxViewersPerStream() { return envInt("LIVE_MAX_VIEWERS_PER_STREAM", 5000); },
  /** Gazda poate lipsi (app în fundal, rețea) atâtea secunde înainte ca streamul să se încheie. */
  get hostGraceSec() { return envInt("LIVE_HOST_GRACE_SEC", 90); },
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
