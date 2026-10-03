/**
 * Shared types + DB writer for the granular feed-event tracking pipeline.
 *
 * Used by:
 *   - POST /api/feed/event           (single fire-and-forget event)
 *   - POST /api/feed/events/batch    (bulk flush from the player)
 *   - lib/feed/track.ts              (client API)
 *
 * Event taxonomy and ranking formula:
 *   docs/feed-tracking.md
 */

import crypto from "crypto";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { FEED_EVENT_TYPES, isFeedEventType, type FeedEventType } from "@/lib/feed/event-types";

export { FEED_EVENT_TYPES, isFeedEventType, type FeedEventType };

let feedSaltWarned = false;


/** Default ranking weight per event type (used by /api/feed/recommendations). */
export const FEED_EVENT_WEIGHTS: Record<FeedEventType, number> = {
  video_view: 0.5,
  watch_time: 0, // computed from watch_ms separately
  completion: 5,
  rewatch: 4,
  skip_fast: -4,
  pause: 0.2,
  resume: 0.2,
  seek: 0,
  like: 3,
  unlike: -1,
  save: 6,
  unsave: -2,
  share: 5,
  comment: 4,
  follow: 4,
  unfollow: -2,
  product_click: 3,
  add_to_cart: 7,
  purchase: 15,
  not_interested: -8,
  more_like_this: 4,
  report: -20,
  impression: 0.1,
};

export type FeedEventInput = {
  event_type: FeedEventType;
  video_id?: string | null;
  watch_ms?: number | null;
  position_ms?: number | null;
  session_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type NormalizedFeedEvent = {
  event_type: FeedEventType;
  video_id: string | null;
  watch_ms: number | null;
  position_ms: number | null;
  session_id: string;
  metadata: Record<string, unknown>;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function clampInt(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const v = Math.max(0, Math.floor(value));
  return Math.min(v, max);
}

export function normalizeFeedEvent(
  raw: unknown,
  fallbackSessionId: string,
): NormalizedFeedEvent | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "invalid event" };
  const r = raw as Record<string, unknown>;

  if (!isFeedEventType(r.event_type)) {
    return { error: `invalid event_type: ${String(r.event_type)}` };
  }

  const videoId = typeof r.video_id === "string" && isUuid(r.video_id) ? r.video_id : null;
  // video_id is optional only for non-video events (e.g. session bootstrap impressions)
  // For now, allow null and let the DB FK be permissive.

  const sessionId =
    typeof r.session_id === "string" && r.session_id.length > 0 && r.session_id.length <= 64
      ? r.session_id
      : fallbackSessionId;

  const metadata =
    r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)
      ? (r.metadata as Record<string, unknown>)
      : {};

  return {
    event_type: r.event_type,
    video_id: videoId,
    watch_ms: clampInt(r.watch_ms, 6 * 60 * 60 * 1000), // cap 6h
    position_ms: clampInt(r.position_ms, 6 * 60 * 60 * 1000),
    session_id: sessionId,
    metadata,
  };
}

/** Hash an IP address with a daily-rotating salt for privacy. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip || ip === "unknown") return null;
  let salt = process.env.FEED_EVENT_IP_SALT;
  if (!salt) {
    if (process.env.NODE_ENV === "production" && !feedSaltWarned) {
      feedSaltWarned = true;
      logger.warn(
        "FEED_EVENT_IP_SALT lipsește în producție — hashing IP cu salt implicit predictibil. Setează FEED_EVENT_IP_SALT."
      );
    }
    salt = "swypik-feed-events";
  }
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

export type FeedEventContext = {
  userId: string | null;
  ipHash: string | null;
  country: string | null;
};

/**
 * Bulk-insert events with a single round-trip. Returns the number of rows
 * inserted. Designed to never throw on individual row failures — caller can
 * fire-and-forget. The route handler logs structured errors.
 */
export async function insertFeedEvents(
  events: NormalizedFeedEvent[],
  ctx: FeedEventContext,
): Promise<number> {
  if (events.length === 0) return 0;

  // Build a single INSERT ... VALUES (...) statement with positional params.
  const values: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const e of events) {
    values.push(
      `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}::jsonb, $${i++}, $${i++}, NOW())`,
    );
    params.push(
      ctx.userId,
      e.session_id,
      e.video_id,
      e.event_type,
      e.watch_ms,
      e.position_ms,
      // legacy column kept populated so existing fan-out consumers see the row
      "global",
      JSON.stringify(e.metadata),
      ctx.ipHash,
      ctx.country,
    );
  }

  const sql = `
    INSERT INTO feed_events (
      actor_user_id,
      session_id,
      video_id,
      event_type,
      watch_ms,
      position_ms,
      audience,
      metadata,
      ip_hash,
      country,
      occurred_at
    ) VALUES ${values.join(", ")}
  `;

  const result = await dbQuery(sql, params);
  return result.rowCount ?? events.length;
}
