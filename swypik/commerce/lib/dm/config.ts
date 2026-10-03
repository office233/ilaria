/**
 * Limite Messenger reglabile din env (fără deploy de cod):
 *   DM_<NUME>_LIMIT / DM_<NUME>_WINDOW, DM_MAX_BODY, DM_PAGE_SIZE …
 */
import type { RateLimitConfig } from "@/lib/security/rate-limit";
import { intEnv } from "@/lib/config/env";

export const DM_GROUP_TITLE_MAX = 120;
export const DM_GROUP_MEMBERS_HARD_MAX = 1024;

function limit(key: string, defLimit: number, defWindow: number): RateLimitConfig {
  return { limit: intEnv(`DM_${key}_LIMIT`, defLimit, 1), window: intEnv(`DM_${key}_WINDOW`, defWindow, 1) };
}

export const DM_CONFIG = {
  /** Lungimea maximă a unui mesaj text (egală cu CHECK-ul din DB). */
  get maxBody() { return intEnv("DM_MAX_BODY", 4000, 1, 4000); },
  /** Mesaje încărcate per pagină în chat. */
  get pageSize() { return intEnv("DM_PAGE_SIZE", 30, 1); },
  /** Previzualizarea mesajului în notificare. */
  get notifyPreviewChars() { return intEnv("DM_NOTIFY_PREVIEW", 80, 1); },
  /** Indicatorul „scrie…” dispare după atâtea ms fără alt semnal. */
  get typingTtlMs() { return intEnv("DM_TYPING_TTL_MS", 4000, 1); },
  /** Imagini atașate: dimensiune maximă (MB) — plafonată de limita uploadFile (5 MB). */
  get attachmentMaxMb() { return intEnv("DM_ATTACHMENT_MAX_MB", 5, 1, 5); },
  /** Participanți totali într-un grup, inclusiv creatorul. */
  get maxGroupMembers() { return intEnv("DM_GROUP_MAX_MEMBERS", 128, 3, DM_GROUP_MEMBERS_HARD_MAX); },
  rate: {
    get typing() { return limit("TYPING", 30, 60); },
    get attachment() { return limit("ATTACHMENT", 10, 60); },
    get block() { return limit("BLOCK", 20, 3600); },
    get report() { return limit("REPORT", 10, 3600); },
    get groupManage() { return limit("GROUP_MANAGE", 30, 60); },
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
