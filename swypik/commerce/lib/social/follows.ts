/**
 * Follow/unfollow idempotent + liste de urmăritori/urmăriți cu cursor.
 * Numărătoarea e live (COUNT pe indexurile follows_*_created_at_idx) — nu
 * există contor denormalizat care să poată deriva.
 */
import { dbQuery } from "@/lib/db";
import { isBlockedEitherWay, notBlockedSql } from "./blocks";
import { decodeCursor, nextCursorFrom } from "./cursor";

export type FollowResult = { following: boolean; changed: boolean; followerCount: number };

export class FollowError extends Error {
  constructor(readonly code: "cannot_follow_self" | "user_not_found" | "blocked") {
    super(code);
    this.name = "FollowError";
  }
}

export async function followerCount(userId: string): Promise<number> {
  const { rows } = await dbQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM follows WHERE following_user_id = $1`,
    [userId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function isFollowing(followerId: string | null, targetId: string): Promise<boolean> {
  if (!followerId || followerId === targetId) return false;
  const { rows } = await dbQuery(
    `SELECT 1 FROM follows WHERE follower_user_id = $1 AND following_user_id = $2 LIMIT 1`,
    [followerId, targetId],
  );
  return rows.length > 0;
}

async function assertFollowable(followerId: string, targetId: string): Promise<void> {
  if (followerId === targetId) throw new FollowError("cannot_follow_self");
  const { rows } = await dbQuery(
    `SELECT 1 FROM users WHERE id = $1 AND COALESCE(status, 'active') = 'active' LIMIT 1`,
    [targetId],
  );
  if (rows.length === 0) throw new FollowError("user_not_found");
  if (await isBlockedEitherWay(followerId, targetId)) throw new FollowError("blocked");
}

export async function setFollow(followerId: string, targetId: string, follow: boolean): Promise<FollowResult> {
  let changed: boolean;
  if (follow) {
    await assertFollowable(followerId, targetId);
    const res = await dbQuery(
      `INSERT INTO follows (follower_user_id, following_user_id) VALUES ($1, $2)
       ON CONFLICT (follower_user_id, following_user_id) DO NOTHING
       RETURNING id`,
      [followerId, targetId],
    );
    changed = res.rows.length > 0;
  } else {
    const res = await dbQuery(
      `DELETE FROM follows WHERE follower_user_id = $1 AND following_user_id = $2 RETURNING id`,
      [followerId, targetId],
    );
    changed = res.rows.length > 0;
  }
  return { following: follow, changed, followerCount: await followerCount(targetId) };
}

export type FollowListItem = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isVerified: boolean;
  /** Viewerul îl urmărește deja (pentru butonul din listă). */
  viewerFollows: boolean;
  isViewer: boolean;
};

type FollowRow = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  is_verified: boolean | null;
  followed_at: string;
  viewer_follows: boolean;
};

/**
 * `direction = "followers"`: cine îl urmărește pe `userId`;
 * `direction = "following"`: pe cine urmărește `userId`.
 * Conturile inactive și cele blocate reciproc cu viewerul sunt excluse.
 */
export async function listFollows(
  userId: string,
  direction: "followers" | "following",
  opts: { viewerId: string | null; cursor: string | null; limit: number },
): Promise<{ items: FollowListItem[]; nextCursor: string | null }> {
  const [matchCol, otherCol] =
    direction === "followers" ? ["following_user_id", "follower_user_id"] : ["follower_user_id", "following_user_id"];
  const cursor = decodeCursor(opts.cursor);
  const params: unknown[] = [userId, opts.viewerId, opts.limit + 1];
  let cursorSql = "";
  if (cursor) {
    params.push(cursor.at, cursor.id);
    cursorSql = `AND (f.created_at, u.id) < ($4::timestamptz, $5::uuid)`;
  }
  const blockSql = opts.viewerId ? `AND ${notBlockedSql("u.id", "$2")}` : "";

  const { rows } = await dbQuery<FollowRow>(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_verified,
            f.created_at AS followed_at,
            ($2::uuid IS NOT NULL AND EXISTS (
              SELECT 1 FROM follows vf WHERE vf.follower_user_id = $2::uuid AND vf.following_user_id = u.id
            )) AS viewer_follows
       FROM follows f
       JOIN users u ON u.id = f.${otherCol}
      WHERE f.${matchCol} = $1
        AND u.status = 'active'
        ${blockSql}
        ${cursorSql}
      ORDER BY f.created_at DESC, u.id DESC
      LIMIT $3`,
    params,
  );

  const page = nextCursorFrom(rows, opts.limit, (r) => r.followed_at);
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name?.trim() || r.username,
      avatarUrl: r.avatar_url || null,
      isVerified: Boolean(r.is_verified),
      viewerFollows: Boolean(r.viewer_follows),
      isViewer: r.id === opts.viewerId,
    })),
  };
}
