/**
 * Limite anti-abuz (2026-09-26, w1-security). Separate de RATE_LIMITS ca să
 * poată fi reglate din env fără deploy de cod:
 *   ABUSE_<NUME>_LIMIT / ABUSE_<NUME>_WINDOW  (ex. ABUSE_ANON_MINT_LIMIT=20)
 */
import type { RateLimitConfig } from "@/lib/security/rate-limit";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function limit(key: string, defLimit: number, defWindow: number): RateLimitConfig {
  return {
    limit: envInt(`ABUSE_${key}_LIMIT`, defLimit),
    window: envInt(`ABUSE_${key}_WINDOW`, defWindow),
  };
}

export const ABUSE_LIMITS = {
  /** Identități anonime noi (rând `users` + cookie) per IP. */
  get anonMint() { return limit("ANON_MINT", 10, 3600); },
  /** Sesiuni de feed anonime semnate emise per IP. */
  get feedSessionMint() { return limit("FEED_SESSION_MINT", 30, 3600); },
  /** Batch-uri de evenimente feed per identitate verificată. */
  get feedEventsPerIdentity() { return limit("FEED_EVENTS_IDENTITY", 30, 60); },
  /** Follow/unfollow per IP (pe lângă limita per user). */
  get followPerIp() { return limit("FOLLOW_IP", 60, 3600); },
  /** Share per IP (pe lângă limita per user). */
  get sharePerIp() { return limit("SHARE_IP", 60, 3600); },
  /** Like pe comentariu per IP. */
  get commentLikePerIp() { return limit("COMMENT_LIKE_IP", 120, 3600); },
  /** Mesaje/conversații DM per IP. */
  get dmPerIp() { return limit("DM_IP", 60, 60); },
} as const;

/** Plafoane per (identitate, video, tip eveniment) într-o fereastră de 24h. */
export const FEED_EVENT_CAPS = {
  windowHours: envInt("FEED_EVENT_CAP_WINDOW_HOURS", 24),
  /** Semnale puternice/negative: o singură dată per identitate per video. */
  oncePerVideo: envInt("FEED_EVENT_CAP_STRONG", 1),
  /** Evenimente "moi" (view, watch_time, pause...) per identitate per video. */
  softPerVideo: envInt("FEED_EVENT_CAP_SOFT", 20),
  /** watch_ms per eveniment ≤ durata × factor. */
  watchDurationFactor: Number(process.env.FEED_EVENT_WATCH_FACTOR) > 0
    ? Number(process.env.FEED_EVENT_WATCH_FACTOR)
    : 1.2,
} as const;
