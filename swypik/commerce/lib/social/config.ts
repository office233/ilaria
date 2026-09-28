/**
 * Limite și reguli pentru profiluri/like/comentarii/follow — un singur loc,
 * reglabile din env fără deploy de cod (SOCIAL_<NUME>).
 */
import type { RateLimitConfig } from "@/lib/security/rate-limit";

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function limit(key: string, defLimit: number, defWindow: number): RateLimitConfig {
  return {
    limit: envInt(`SOCIAL_${key}_LIMIT`, defLimit),
    window: envInt(`SOCIAL_${key}_WINDOW`, defWindow),
  };
}

export const SOCIAL_PAGE = {
  comments: 20,
  replies: 10,
  /** Răspunsuri livrate inline sub fiecare comentariu de nivel 1. */
  inlineReplies: 2,
  follows: 30,
  videos: 24,
  maxPage: 60,
} as const;

export const SOCIAL_LIMITS = {
  get videoLikePerIp() { return limit("VIDEO_LIKE_IP", 40, 60); },
  get commentPerIp() { return limit("COMMENT_IP", 15, 60); },
  get reportPerUser() { return limit("REPORT", 10, 3600); },
  get blockPerUser() { return limit("BLOCK", 30, 3600); },
  get pinPerUser() { return limit("PIN", 30, 60); },
  get usernameCheck() { return limit("USERNAME_CHECK", 30, 60); },
  get privacyEdit() { return limit("PRIVACY_EDIT", 20, 600); },
  /** Mențiuni care generează notificări, per comentariu. */
  get mentionsPerComment() { return envInt("SOCIAL_MENTIONS_PER_COMMENT", 5); },
} as const;

export const USERNAME_RULES = {
  min: 3,
  max: 30,
  pattern: /^[a-z0-9_]+$/,
} as const;

/**
 * Nume rezervate (rute, roluri, brand). Lista de bază + extensie din env
 * `SOCIAL_RESERVED_USERNAMES` (separate prin virgulă).
 */
const BASE_RESERVED = [
  "admin", "administrator", "api", "app", "auth", "account", "support", "help",
  "swypik", "official", "moderator", "system", "root", "seller", "creator",
  "courier", "settings", "explore", "inbox", "notifications", "null", "undefined",
];

export function reservedUsernames(): Set<string> {
  const extra = (process.env.SOCIAL_RESERVED_USERNAMES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...BASE_RESERVED, ...extra]);
}

/** Motive acceptate pentru rapoarte (CHECK pe moderation_reports.reason). */
export const REPORT_REASONS = [
  "spam",
  "harassment",
  "hate",
  "violence",
  "sexual_content",
  "scam",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
