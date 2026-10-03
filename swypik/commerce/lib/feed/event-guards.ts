/**
 * Reguli anti-manipulare pentru evenimentele de feed (pure, fără I/O).
 *
 * Audit feed-algorithm (2026-09): /api/feed/events/batch accepta completion /
 * skip_fast / report / watch_ms arbitrare, anonim, pentru orice video → un clip
 * putea fi împins pe #1 sau îngropat. Aici:
 *   - evenimentele pentru video inexistente sunt aruncate;
 *   - watch_ms păstrat DOAR pe `watch_time`, plafonat la durata × factor;
 *   - semnalele puternice/negative: max N per identitate per video (fereastră);
 *   - restul: plafon "soft" per identitate per video;
 *   - `report` doar de la conturi reale (anonimii nu influențează ranking-ul).
 */
import type { FeedEventType } from "@/lib/feed/event-types";
import type { NormalizedFeedEvent } from "@/lib/feed/events";
import { FEED_EVENT_CAPS } from "@/lib/security/abuse-limits";

/** Tipuri numărate o singură dată per identitate per video. */
export const ONCE_PER_VIDEO_TYPES: ReadonlySet<FeedEventType> = new Set<FeedEventType>([
  "completion",
  "skip_fast",
  "report",
  "more_like_this",
  "not_interested",
  "product_click",
  "share",
]);

/** Tipuri care cer cont real (nu shell anonim / sesiune de feed). */
export const ACCOUNT_ONLY_TYPES: ReadonlySet<FeedEventType> = new Set<FeedEventType>(["report"]);

/** Plafon watch_ms când durata clipului e necunoscută (10 min). */
export const UNKNOWN_DURATION_WATCH_CAP_MS = 10 * 60 * 1000;

export type GuardContext = {
  /** true = cont real autentificat. */
  isAccount: boolean;
  /** video_id → duration_ms (null = necunoscută). Lipsă = video inexistent. */
  videos: ReadonlyMap<string, number | null>;
  /** `${video_id}:${event_type}` → câte există deja în fereastră pentru identitate. */
  priorCounts: ReadonlyMap<string, number>;
};

export type GuardResult = {
  accepted: NormalizedFeedEvent[];
  dropped: number;
};

export function capKey(videoId: string, type: FeedEventType): string {
  return `${videoId}:${type}`;
}

function capFor(type: FeedEventType): number {
  return ONCE_PER_VIDEO_TYPES.has(type) ? FEED_EVENT_CAPS.oncePerVideo : FEED_EVENT_CAPS.softPerVideo;
}

function clampWatch(e: NormalizedFeedEvent, durationMs: number | null): number | null {
  if (e.event_type !== "watch_time" || e.watch_ms == null) return null;
  const max =
    durationMs && durationMs > 0
      ? Math.round(durationMs * FEED_EVENT_CAPS.watchDurationFactor)
      : UNKNOWN_DURATION_WATCH_CAP_MS;
  return Math.min(e.watch_ms, max);
}

export function applyFeedEventGuards(
  events: readonly NormalizedFeedEvent[],
  ctx: GuardContext,
): GuardResult {
  const counts = new Map(ctx.priorCounts);
  const accepted: NormalizedFeedEvent[] = [];
  let dropped = 0;

  for (const e of events) {
    if (ACCOUNT_ONLY_TYPES.has(e.event_type) && !ctx.isAccount) {
      dropped++;
      continue;
    }
    if (e.video_id == null) {
      // Evenimentele fără video nu intră în ranking; păstrăm fără watch_ms.
      accepted.push({ ...e, watch_ms: null });
      continue;
    }
    if (!ctx.videos.has(e.video_id)) {
      dropped++;
      continue;
    }
    const key = capKey(e.video_id, e.event_type);
    const seen = counts.get(key) ?? 0;
    if (seen >= capFor(e.event_type)) {
      dropped++;
      continue;
    }
    counts.set(key, seen + 1);
    accepted.push({ ...e, watch_ms: clampWatch(e, ctx.videos.get(e.video_id) ?? null) });
  }

  return { accepted, dropped };
}
