# Feed Event Tracking & Personalised Ranking

This document describes the dense event-tracking pipeline that powers
TikTok-style personalisation on Swypik.

## Event taxonomy

Granular events written to `feed_events` (column `event_type`):

| Event             | Meaning                                                        | Weight |
| ----------------- | -------------------------------------------------------------- | ------ |
| `impression`      | Video card appeared in viewport (>= 60% visible).              | +0.1   |
| `video_view`      | Playback started.                                              | +0.5   |
| `watch_time`      | Periodic watch-progress tick (every 5 s + on pause/end).       | varies |
| `completion`      | User watched the entire video.                                 | +5     |
| `rewatch`         | Same user replayed the same video.                             | +4     |
| `skip_fast`       | User swiped away in **< 1 s** — strongest negative signal.     | -4     |
| `pause`           | Playback paused.                                               | +0.2   |
| `resume`          | Playback resumed.                                              | +0.2   |
| `seek`            | User scrubbed timeline.                                        | 0      |
| `like`/`unlike`   | Like / unlike action.                                          | +3/-1  |
| `save`/`unsave`   | Save to collection.                                            | +6/-2  |
| `share`           | Share button or external share.                                | +5     |
| `comment`         | New comment posted.                                            | +4     |
| `follow`/`unfollow`| Creator follow toggle.                                        | +4/-2  |
| `product_click`   | Tap on a tagged product.                                       | +3     |
| `add_to_cart`     | Product added to cart from this video.                         | +7     |
| `purchase`        | Order completed where the video influenced the cart.           | +15    |
| `not_interested`  | Explicit "not interested" action.                              | -8     |
| `more_like_this`  | Explicit "more like this" action.                              | +4     |
| `report`          | Abuse report (also drives moderation).                         | -20    |

The full enum and weight map lives in `lib/feed/events.ts`
(`FEED_EVENT_TYPES`, `FEED_EVENT_WEIGHTS`).

## Endpoints

### `POST /api/feed/event`

Single event, fire-and-forget. Auth optional.

```json
{
  "event_type": "skip_fast",
  "video_id":   "5d35…-uuid",
  "watch_ms":   650,
  "position_ms": 0,
  "session_id": "anon-7c1f…",
  "metadata":   { "source": "product-feed", "position": 3 }
}
```

Returns `204 No Content` on accept. Rate-limited at **50 events / min per
session**.

### `POST /api/feed/events/batch`

Bulk variant (`{ events: [...] }`). The owner spec refers to this endpoint as
`/api/feed/events:batch`; Windows-safe folder naming forces the on-disk path
`app/api/feed/events/batch/`. The URL is therefore
`/api/feed/events/batch`. Max **50** events per request, **20 batches /
min** per session.

### `GET /api/feed/recommendations` — ELIMINAT (2026-09-26)

Înlocuit de ranker-ul unic din `lib/feed/` servit de `GET /api/explore/feed`
(candidați → scor pe rate netezite → bandit Thompson → diversitate → cursor).
Descrierea istorică de mai jos nu mai e validă.

Returns the personalised ranking for the calling user (or session). Pulls the
last 200 candidate videos, aggregates 14-day signals from `feed_events`, and
applies a category-affinity boost based on the user's last-30-day positive
signals. Output:

```json
{
  "personalised": true,
  "video_ids": ["uuid1", "uuid2", ...],
  "results":   [{ "id": "uuid1", "category_id": "fashion", "score": 17.5 }, ...]
}
```

## Client helper (`lib/feed/track.ts`)

```ts
import {
  getSessionId, trackEvent, trackWatchTime,
  flushWatchTime, resetWatchTime, trackEventImmediate,
} from "@/lib/feed/track";

trackEvent("video_view", { video_id });
setInterval(() => trackWatchTime(video_id, video.currentTime * 1000), 250);
videoEl.addEventListener("ended", () => {
  flushWatchTime(video_id);
  trackEvent("completion", { video_id, watch_ms: video.duration * 1000 });
  resetWatchTime(video_id);
});

// Immediate (skip batching) for business-critical events:
await trackEventImmediate("purchase", { video_id, metadata: { order_id } });
```

Batching defaults: flush after 10 events queued OR 2 s of inactivity. On
`pagehide` / `visibilitychange:hidden` the queue is flushed via
`navigator.sendBeacon` so events survive navigation away.

`getSessionId()` persists to `localStorage["swypik_feed_session"]` and falls
back to an in-memory UUID under SSR / private mode.

## Schema (`feed_events`)

See `db/migrations/20260513_0008_feed_events_tracking.sql`. Key columns added
on top of the original social-fanout schema:

| Column        | Type      | Notes                                                |
| ------------- | --------- | ---------------------------------------------------- |
| `session_id`  | `text`    | Required for anonymous tracking                      |
| `watch_ms`    | `integer` | Watched milliseconds for the event window            |
| `position_ms` | `integer` | Player position when event fired                     |
| `ip_hash`     | `text`    | SHA-256(salt + ip) — first 32 chars                  |
| `country`     | `text`    | `cf-ipcountry` if available                          |

Indexes added:

* `(actor_user_id, occurred_at DESC)`
* `(video_id, event_type)`
* `(session_id, occurred_at DESC)`
* BRIN on `occurred_at` for cheap time-range aggregations

### Partitioning (deferred)

Once row volume exceeds ~50 M, convert `feed_events` to monthly RANGE
partitions on `occurred_at`:

1. Rename existing → `feed_events_legacy`.
2. Create new `feed_events PARTITION BY RANGE (occurred_at)` with identical
   columns.
3. Backfill via `INSERT … SELECT` per month.
4. Attach monthly partitions, dropping the legacy table once parity is
   confirmed.

This is intentionally out of scope of the current migration.

## Component integration

`components/ProductFeed.tsx` emits to **both** pipelines:

* Legacy `/api/v1/events` (Go social service) — unchanged.
* New `/api/feed/event(s)` via `lib/feed/track.ts`.

A `useEffect` watcher emits `skip_fast` whenever `currentIdx` advances within
< 1 s of the previous card becoming active.

## Coordination

* Agent 3 owns `/api/feed/more-like-this` and `/api/feed/not-interested`
  endpoints. They should call `insertFeedEvents([...])` from
  `lib/feed/events.ts` for the underlying audit row; the ranking-side boost
  is the responsibility of the recommendations endpoint (already implemented
  here for `more_like_this`; `not_interested` is treated as a strong negative
  signal).

## Deployment TODO

1. **Run migration** in production:
   `db/migrations/20260513_0008_feed_events_tracking.sql`.
2. **Env vars (optional)**:
   * `FEED_EVENT_IP_SALT` — rotation-friendly salt for IP hashing
     (defaults to a constant; rotate daily via cron + restart).
   * `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — required for
     distributed rate limiting; without them the route falls back to a
     per-process in-memory limiter.
3. **Backfill (optional)**: keep `feed_events` row count light for the first
   24 h to observe insert latency, then enable the client tracker site-wide
   by removing the legacy `/api/v1/events` fanout once parity is confirmed.

## Roadmap

* **A/B testing**: introduce `experiment_id` column in `feed_events.metadata`
  and split traffic via `lib/feed/track.ts` based on a hashed user id.
* **Anti-spam hardening**: bot-detection signal (`metadata.bot_score`)
  populated from a Cloudflare worker; downweight scores when score > 0.7.
* **More-like-this boost**: agent 3 surfaces signals; ranking endpoint adds
  a category- and creator-level boost weighted by recency of the action.
* **Embedding-based candidate generation**: replace the LIMIT-200 candidate
  query with an ANN lookup against video embeddings stored in pgvector.
* **Stream to ClickHouse**: tee `feed_events` to ClickHouse via the existing
  `analytics_delivery_batches` infrastructure for warehouse analytics.
