import { dbQuery, getDb } from "@/lib/db";

/**
 * Helpers for feed personalization preferences:
 *   - user_interests (topic-weight pairs, used for ranking boosts)
 *   - user_hidden_videos (videos to exclude from a user's feed)
 *
 * Topic resolution: videos.tags is text[]. We treat the first tag as the
 * primary topic. Callers can also pass an explicit topic.
 */

const INTEREST_MIN = -5;
const INTEREST_MAX = 5;

export type InterestSource =
  | "onboarding"
  | "explicit"
  | "inferred"
  | "more_like_this"
  | "not_interested";

function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(INTEREST_MIN, Math.min(INTEREST_MAX, value));
}

/**
 * Upsert a (user, topic) interest pair, additively bumping the weight.
 * Weight is clamped to [-5, 5].
 */
export async function bumpUserInterest(
  userId: string,
  topic: string,
  delta: number,
  source: InterestSource = "inferred",
): Promise<void> {
  const trimmed = topic.trim().toLowerCase();
  if (!trimmed) return;

  await dbQuery(
    `INSERT INTO user_interests (user_id, topic, weight, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, topic) DO UPDATE
       SET weight = GREATEST($5, LEAST($6, user_interests.weight + EXCLUDED.weight)),
           source = EXCLUDED.source,
           updated_at = NOW()`,
    [userId, trimmed, clampWeight(delta), source, INTEREST_MIN, INTEREST_MAX],
  );
}

/**
 * Look up the primary topic for a video (first non-empty tag) plus all tags.
 */
export async function getVideoTopics(
  videoId: string,
): Promise<{ primary: string | null; tags: string[] }> {
  const { rows } = await dbQuery<{ tags: string[] | null }>(
    `SELECT tags FROM videos WHERE id = $1`,
    [videoId],
  );
  const tags = (rows[0]?.tags ?? []).filter((t) => typeof t === "string" && t.length > 0);
  return { primary: tags[0] ?? null, tags };
}

/**
 * Hide a video for a user (idempotent).
 */
export async function hideVideoForUser(
  userId: string,
  videoId: string,
  reason: "not_interested" | "reported" | "already_seen" | "blocked_creator" = "not_interested",
): Promise<void> {
  await dbQuery(
    `INSERT INTO user_hidden_videos (user_id, video_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, video_id) DO UPDATE
       SET reason = EXCLUDED.reason,
           hidden_at = NOW()`,
    [userId, videoId, reason],
  );
}

/**
 * Record a feed_events row server-side. Mirrors the contract used by
 * lib/feed/track.ts (agent 2) but executed directly against pg.
 * Score is intentionally small for explicit signals: feed ranking uses it
 * as a tie-breaker, the real boost comes from user_interests.
 */
export async function recordFeedEvent(params: {
  userId: string;
  videoId: string;
  eventType:
    | "more_like_this"
    | "not_interested"
    | "video_hidden"
    | "creator_followed"
    | "creator_unfollowed";
  metadata?: Record<string, unknown>;
  score?: number;
  audience?: "global" | "followers" | "personalized";
}): Promise<void> {
  const { userId, videoId, eventType, metadata = {}, score = 0, audience = "personalized" } = params;
  await dbQuery(
    `INSERT INTO feed_events
       (actor_user_id, video_id, event_type, audience, score, source, metadata)
     VALUES ($1, $2, $3, $4, $5, 'feed_action', $6::jsonb)`,
    [userId, videoId, eventType, audience, score, JSON.stringify(metadata)],
  );
}

/**
 * Convenience: write user_watch_events row for the explicit signal too.
 * This is what the existing engagement pipeline reads (user_watch_events
 * already supports more_like_this / not_interested in its CHECK).
 */
export async function recordWatchEvent(params: {
  userId: string;
  videoId: string;
  eventType: "more_like_this" | "not_interested" | "follow" | "unfollow" | "report";
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { userId, videoId, eventType, metadata = {} } = params;
  await dbQuery(
    `INSERT INTO user_watch_events (user_id, video_id, event_type, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [userId, videoId, eventType, JSON.stringify(metadata)],
  );
}

/**
 * One-shot helper used by /api/feed/action — runs the inserts in a single
 * transaction so a partial failure doesn't desync interests vs. events.
 */
export async function applyFeedAction(params: {
  userId: string;
  videoId: string;
  action: "more_like_this" | "not_interested";
}): Promise<void> {
  const { userId, videoId, action } = params;
  const { primary, tags } = await getVideoTopics(videoId);

  const pool = getDb();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (action === "more_like_this") {
      await client.query(
        `INSERT INTO feed_events
           (actor_user_id, video_id, event_type, audience, score, source, metadata)
         VALUES ($1, $2, 'more_like_this', 'personalized', 5, 'feed_action', $3::jsonb)`,
        [userId, videoId, JSON.stringify({ topic: primary, tags })],
      );
      await client.query(
        `INSERT INTO user_watch_events (user_id, video_id, event_type, metadata)
         VALUES ($1, $2, 'more_like_this', $3::jsonb)`,
        [userId, videoId, JSON.stringify({ topic: primary })],
      );
      if (primary) {
        await client.query(
          `INSERT INTO user_interests (user_id, topic, weight, source)
           VALUES ($1, $2, 5, 'more_like_this')
           ON CONFLICT (user_id, topic) DO UPDATE
             SET weight = GREATEST(-5, LEAST(5, user_interests.weight + 5)),
                 source = 'more_like_this',
                 updated_at = NOW()`,
          [userId, primary],
        );
      }
    } else {
      await client.query(
        `INSERT INTO feed_events
           (actor_user_id, video_id, event_type, audience, score, source, metadata)
         VALUES ($1, $2, 'not_interested', 'personalized', -5, 'feed_action', $3::jsonb)`,
        [userId, videoId, JSON.stringify({ topic: primary, tags })],
      );
      await client.query(
        `INSERT INTO user_watch_events (user_id, video_id, event_type, metadata)
         VALUES ($1, $2, 'not_interested', $3::jsonb)`,
        [userId, videoId, JSON.stringify({ topic: primary })],
      );
      await client.query(
        `INSERT INTO user_hidden_videos (user_id, video_id, reason)
         VALUES ($1, $2, 'not_interested')
         ON CONFLICT (user_id, video_id) DO UPDATE
           SET reason = 'not_interested', hidden_at = NOW()`,
        [userId, videoId],
      );
      if (primary) {
        await client.query(
          `INSERT INTO user_interests (user_id, topic, weight, source)
           VALUES ($1, $2, -3, 'not_interested')
           ON CONFLICT (user_id, topic) DO UPDATE
             SET weight = GREATEST(-5, LEAST(5, user_interests.weight - 3)),
                 source = 'not_interested',
                 updated_at = NOW()`,
          [userId, primary],
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
