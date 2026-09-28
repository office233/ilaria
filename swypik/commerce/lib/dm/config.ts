/**
 * Limite Messenger reglabile din env (fără deploy de cod):
 *   DM_<NUME>_LIMIT / DM_<NUME>_WINDOW, DM_MAX_BODY, DM_PAGE_SIZE …
 */
import type { RateLimitConfig } from "@/lib/security/rate-limit";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function limit(key: string, defLimit: number, defWindow: number): RateLimitConfig {
  return { limit: envInt(`DM_${key}_LIMIT`, defLimit), window: envInt(`DM_${key}_WINDOW`, defWindow) };
}

export const DM_CONFIG = {
  /** Lungimea maximă a unui mesaj text (egală cu CHECK-ul din DB). */
  get maxBody() { return Math.min(envInt("DM_MAX_BODY", 4000), 4000); },
  /** Mesaje încărcate per pagină în chat. */
  get pageSize() { return envInt("DM_PAGE_SIZE", 30); },
  /** Previzualizarea mesajului în notificare. */
  get notifyPreviewChars() { return envInt("DM_NOTIFY_PREVIEW", 80); },
  /** Indicatorul „scrie…” dispare după atâtea ms fără alt semnal. */
  get typingTtlMs() { return envInt("DM_TYPING_TTL_MS", 4000); },
  /** Imagini atașate: dimensiune maximă (MB) — plafonată de limita uploadFile (5 MB). */
  get attachmentMaxMb() { return Math.min(envInt("DM_ATTACHMENT_MAX_MB", 5), 5); },
  rate: {
    get typing() { return limit("TYPING", 30, 60); },
    get attachment() { return limit("ATTACHMENT", 10, 60); },
    get block() { return limit("BLOCK", 20, 3600); },
    get report() { return limit("REPORT", 10, 3600); },
  },
} as const;

/** Tipuri MIME acceptate pentru imagini în chat (subset din lib/storage/upload). */
export const DM_ATTACHMENT_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/** Motive de raportare acceptate de moderation_reports.reason. */
export const DM_REPORT_REASONS = ["spam", "harassment", "hate", "scam", "sexual_content", "other"] as const;
export type DmReportReason = (typeof DM_REPORT_REASONS)[number];

export function dmChannel(conversationId: string): string {
  return `dm:conv:${conversationId}`;
}

/** Cheia unică a unei perechi DM (ordine stabilă), vezi migrarea 0082. */
export function dmPairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
