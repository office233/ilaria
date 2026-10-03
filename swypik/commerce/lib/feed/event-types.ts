/**
 * Feed event types — client-safe (no DB/crypto imports), shared by the browser
 * trackers and the server-side ingestion in lib/feed/events.ts.
 */
export const FEED_EVENT_TYPES = [
  "video_view",
  "watch_time",
  "completion",
  "rewatch",
  "skip_fast",
  "pause",
  "resume",
  "seek",
  "like",
  "unlike",
  "save",
  "unsave",
  "share",
  "comment",
  "follow",
  "unfollow",
  "product_click",
  "add_to_cart",
  "purchase",
  "not_interested",
  "more_like_this",
  "report",
  "impression",
] as const;

export type FeedEventType = (typeof FEED_EVENT_TYPES)[number];

const FEED_EVENT_SET = new Set<string>(FEED_EVENT_TYPES);

export function isFeedEventType(value: unknown): value is FeedEventType {
  return typeof value === "string" && FEED_EVENT_SET.has(value);
}
