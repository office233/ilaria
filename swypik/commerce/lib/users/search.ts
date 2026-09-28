/**
 * Directory search for the messenger "add contact" flow. Matches on
 * username / display_name (prefix, case-insensitive) only — never
 * email/phone, and never returns them.
 */
import { dbQuery } from "@/lib/db";

export type PublicUserResult = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

/** Escape ILIKE wildcards (%, _, \) so user input can't inject pattern matches. */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function searchUsers(
  viewerId: string,
  query: string,
  limit = 20,
): Promise<PublicUserResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const pattern = `${escapeLikePattern(trimmed)}%`;

  const { rows } = await dbQuery<PublicUserResult>(
    `SELECT u.id, u.username, u.display_name, cpr.avatar_url
       FROM users u
       LEFT JOIN creator_profiles cpr ON cpr.user_id = u.id
      WHERE u.id <> $1
        AND COALESCE(u.status, 'active') NOT IN ('suspended', 'banned', 'deleted')
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.blocker_user_id = $1 AND b.blocked_user_id = u.id)
              OR (b.blocker_user_id = u.id AND b.blocked_user_id = $1)
        )
        AND (
          u.username ILIKE $2 ESCAPE '\\'
          OR u.display_name ILIKE $2 ESCAPE '\\'
        )
      ORDER BY
        (u.username ILIKE $2 ESCAPE '\\') DESC,
        u.username NULLS LAST
      LIMIT $3`,
    [viewerId, pattern, Math.min(Math.max(limit, 1), 40)],
  );

  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    display_name: r.display_name,
    avatar_url: r.avatar_url,
  }));
}
