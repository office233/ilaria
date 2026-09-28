/**
 * Client-side helper for emitting feed-tracking events.
 *
 * Design goals:
 *   - Fire-and-forget (no awaits in the player UI thread).
 *   - Batched: events are queued and flushed when either
 *       * `BATCH_FLUSH_SIZE` events are queued, OR
 *       * `BATCH_DEBOUNCE_MS` of inactivity has passed, OR
 *       * the page is about to unload (uses sendBeacon).
 *   - Resilient: a flush failure does not throw into the caller.
 *
 * Usage:
 *   import { trackEvent, trackWatchTime, getSessionId } from "@/lib/feed/track";
 *
 *   trackEvent("video_view", { video_id });
 *   trackEvent("skip_fast", { video_id, watch_ms: 350 });
 *   trackWatchTime(video_id, 5_000);
 *
 * The server endpoint is `/api/feed/event` (single) and
 * `/api/feed/events/batch` (bulk). See docs/feed-tracking.md.
 */

import type { FeedEventType } from "./events";

const SESSION_KEY = "swypik_feed_session";
const BATCH_FLUSH_SIZE = 10;
const BATCH_DEBOUNCE_MS = 2_000;
const WATCH_TIME_TICK_MS = 5_000;

export type TrackPayload = {
  video_id?: string;
  watch_ms?: number;
  position_ms?: number;
  metadata?: Record<string, unknown>;
};

type QueuedEvent = TrackPayload & {
  event_type: FeedEventType;
  session_id: string;
  t: number;
};

/* ------------------------------------------------------------------ */
/* session id                                                          */
/* ------------------------------------------------------------------ */

function uuidv4(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // RFC4122-ish fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getSessionId(): string {
  if (typeof window === "undefined") return "ssr";
  try {
    let sid = window.localStorage.getItem(SESSION_KEY);
    if (!sid) {
      sid = uuidv4();
      window.localStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
  } catch {
    // SSR / private mode — fall back to an in-memory ID.
    return inMemorySession();
  }
}

let memorySession: string | null = null;
function inMemorySession(): string {
  if (!memorySession) memorySession = uuidv4();
  return memorySession;
}

/* ------------------------------------------------------------------ */
/* batching queue                                                      */
/* ------------------------------------------------------------------ */

const queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, BATCH_DEBOUNCE_MS);
}

async function flush(useBeacon = false): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  const body = JSON.stringify({ events: batch });

  // Page-unload path: navigator.sendBeacon is the only reliable channel.
  if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    try {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon("/api/feed/events/batch", blob)) return;
    } catch {
      /* fall through to fetch */
    }
  }

  try {
    await fetch("/api/feed/events/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      credentials: "include",
    });
  } catch {
    // Drop. Tracking failures must never break the UI.
  }
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

export function trackEvent(type: FeedEventType, payload: TrackPayload = {}): void {
  if (typeof window === "undefined") return;
  queue.push({
    event_type: type,
    session_id: getSessionId(),
    t: Date.now(),
    ...payload,
  });
  if (queue.length >= BATCH_FLUSH_SIZE) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    void flush();
  } else {
    scheduleFlush();
  }
}

/**
 * Emit a single high-priority event immediately (skips batching).
 * Use for `purchase`, `report`, `not_interested` — actions whose loss would
 * be observable to the user or downstream business systems.
 */
export async function trackEventImmediate(
  type: FeedEventType,
  payload: TrackPayload = {},
): Promise<void> {
  if (typeof window === "undefined") return;
  const body = JSON.stringify({
    event_type: type,
    session_id: getSessionId(),
    ...payload,
  });
  try {
    await fetch("/api/feed/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      credentials: "include",
    });
  } catch {
    /* swallow */
  }
}

/* ------------------------------------------------------------------ */
/* watch_time accumulator                                              */
/* ------------------------------------------------------------------ */

type WatchAccumulator = {
  videoId: string;
  watchedMs: number;
  lastTickMs: number;
  lastEmittedMs: number;
};

const watchByVideo = new Map<string, WatchAccumulator>();

/**
 * Call repeatedly (e.g. from a video player `timeupdate` handler) with the
 * total `watch_ms` so far for `videoId`. The helper emits a `watch_time`
 * event at most every WATCH_TIME_TICK_MS and on pause/end via
 * `flushWatchTime`.
 */
export function trackWatchTime(videoId: string, totalWatchedMs: number): void {
  if (!videoId || !Number.isFinite(totalWatchedMs) || totalWatchedMs < 0) return;
  const now = Date.now();
  const entry = watchByVideo.get(videoId);
  if (!entry) {
    watchByVideo.set(videoId, {
      videoId,
      watchedMs: totalWatchedMs,
      lastTickMs: now,
      lastEmittedMs: 0,
    });
    return;
  }
  entry.watchedMs = totalWatchedMs;
  if (now - entry.lastTickMs >= WATCH_TIME_TICK_MS) {
    entry.lastTickMs = now;
    const delta = entry.watchedMs - entry.lastEmittedMs;
    if (delta > 0) {
      trackEvent("watch_time", { video_id: videoId, watch_ms: Math.round(delta) });
      entry.lastEmittedMs = entry.watchedMs;
    }
  }
}

/** Force-emit the residual watch_ms for a video (call on pause / end / swipe). */
export function flushWatchTime(videoId: string): number {
  const entry = watchByVideo.get(videoId);
  if (!entry) return 0;
  const delta = entry.watchedMs - entry.lastEmittedMs;
  if (delta > 0) {
    trackEvent("watch_time", { video_id: videoId, watch_ms: Math.round(delta) });
    entry.lastEmittedMs = entry.watchedMs;
  }
  return entry.watchedMs;
}

/** Reset accumulator (call after `completion` is emitted). */
export function resetWatchTime(videoId: string): void {
  watchByVideo.delete(videoId);
}

/* ------------------------------------------------------------------ */
/* lifecycle hooks                                                     */
/* ------------------------------------------------------------------ */

if (typeof window !== "undefined") {
  // Flush any pending events on unload (sendBeacon path).
  const onHide = () => {
    void flush(true);
  };
  window.addEventListener("pagehide", onHide);
  window.addEventListener("beforeunload", onHide);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onHide();
  });
}
