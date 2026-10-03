import { getSessionUserId } from "@/lib/auth/getAuthUser";
import { getOrCreateAnonId, readAnonId } from "@/lib/anon/session";
import { withTransaction } from "@/lib/db";
import { deriveServerSecret } from "@/lib/security/secret-box";

export type VideoViewerIdentity = {
  canonicalKey: string;
  aliases: string[];
  kind: "user" | "anon";
  lockKey: string;
};

function key(kind: "user" | "anon", id: string): string {
  return deriveServerSecret("video-view-dedupe", `${kind}:${id}`);
}

export async function resolveVideoViewerIdentity(): Promise<VideoViewerIdentity> {
  const userId = await getSessionUserId();
  const existingAnon = await readAnonId();

  if (userId) {
    const userKey = key("user", userId);
    const anonKey = existingAnon ? key("anon", existingAnon) : null;
    return {
      canonicalKey: userKey,
      aliases: anonKey ? [userKey, anonKey] : [userKey],
      kind: "user",
      // If this browser was anonymous moments ago, both sides of the
      // anon→user transition serialize on the same pseudonymous key.
      lockKey: anonKey ?? userKey,
    };
  }

  const anonId = existingAnon ?? await getOrCreateAnonId();
  const anonKey = key("anon", anonId);
  return {
    canonicalKey: anonKey,
    aliases: [anonKey],
    kind: "anon",
    lockKey: anonKey,
  };
}

export type VideoViewResult =
  | { found: false; counted: false; views: null }
  | { found: true; counted: boolean; views: number };

export async function recordDedupedVideoView(
  videoId: string,
  identity: VideoViewerIdentity,
  // Called only when this view would actually be counted (not on a deduped
  // repeat). Returning false records nothing and leaves view_count unchanged.
  allowCount?: () => Promise<boolean>,
): Promise<VideoViewResult> {
  return withTransaction(async (q) => {
    await q(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`video-view:${videoId}:${identity.lockKey}`],
    );

    const recent = await q<{ viewer_key: string; last_counted_at: Date | string }>(
      `SELECT viewer_key, last_counted_at
         FROM video_view_dedup
        WHERE video_id = $1
          AND viewer_key = ANY($2::text[])
          AND last_counted_at > now() - interval '24 hours'
        ORDER BY last_counted_at DESC
        LIMIT 1`,
      [videoId, identity.aliases],
    );

    if (recent.rows[0]) {
      // Bridge an anonymous pre-login view to the authenticated identity
      // without incrementing. Clearing the anon cookie after login therefore
      // cannot create a second counted view inside the same 24h window.
      if (
        identity.kind === "user" &&
        recent.rows[0].viewer_key !== identity.canonicalKey
      ) {
        await q(
          `INSERT INTO video_view_dedup
             (video_id, viewer_key, viewer_kind, first_counted_at, last_counted_at, count_events)
           VALUES ($1, $2, 'user', $3::timestamptz, $3::timestamptz, 1)
           ON CONFLICT (video_id, viewer_key)
           DO UPDATE SET last_counted_at = GREATEST(
                           video_view_dedup.last_counted_at,
                           EXCLUDED.last_counted_at
                         )`,
          [videoId, identity.canonicalKey, recent.rows[0].last_counted_at],
        );
      }

      const current = await q<{ view_count: string | number }>(
        `SELECT view_count
           FROM videos
          WHERE id = $1 AND status = 'ready'`,
        [videoId],
      );
      if (!current.rows[0]) return { found: false, counted: false, views: null };
      return {
        found: true,
        counted: false,
        views: Number(current.rows[0].view_count ?? 0),
      };
    }

    if (allowCount && !(await allowCount())) {
      const current = await q<{ view_count: string | number }>(
        `SELECT view_count
           FROM videos
          WHERE id = $1 AND status = 'ready'`,
        [videoId],
      );
      if (!current.rows[0]) return { found: false, counted: false, views: null };
      return {
        found: true,
        counted: false,
        views: Number(current.rows[0].view_count ?? 0),
      };
    }

    const claimed = await q(
      `INSERT INTO video_view_dedup
         (video_id, viewer_key, viewer_kind, first_counted_at, last_counted_at, count_events)
       SELECT $1, $2, $3, now(), now(), 1
         FROM videos
        WHERE id = $1 AND status = 'ready'
       ON CONFLICT (video_id, viewer_key)
       DO UPDATE SET viewer_kind = EXCLUDED.viewer_kind,
                     last_counted_at = now(),
                     count_events = video_view_dedup.count_events + 1
         WHERE video_view_dedup.last_counted_at <= now() - interval '24 hours'
       RETURNING video_id`,
      [videoId, identity.canonicalKey, identity.kind],
    );

    if ((claimed.rowCount ?? 0) === 0) {
      const current = await q<{ view_count: string | number }>(
        `SELECT view_count
           FROM videos
          WHERE id = $1 AND status = 'ready'`,
        [videoId],
      );
      if (!current.rows[0]) return { found: false, counted: false, views: null };
      return {
        found: true,
        counted: false,
        views: Number(current.rows[0].view_count ?? 0),
      };
    }

    const bumped = await q<{ view_count: string | number }>(
      `UPDATE videos
          SET view_count = view_count + 1
        WHERE id = $1 AND status = 'ready'
        RETURNING view_count`,
      [videoId],
    );
    if (!bumped.rows[0]) return { found: false, counted: false, views: null };
    return {
      found: true,
      counted: true,
      views: Number(bumped.rows[0].view_count ?? 0),
    };
  });
}
