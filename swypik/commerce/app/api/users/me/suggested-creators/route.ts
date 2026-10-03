import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  follower_count: string;
  is_verified: boolean | null;
};

export async function GET() {
  try {
    const auth = await getAuthUser();
    if (!auth.userId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const userId = auth.userId;

    const { rows } = await dbQuery<Row>(
      `SELECT u.id,
              u.username,
              COALESCE(cp.display_name, u.display_name) AS display_name,
              COALESCE(cp.avatar_url, u.avatar_url) AS avatar_url,
              COALESCE(cp.bio, u.bio) AS bio,
              (SELECT COUNT(*) FROM follows f WHERE f.following_user_id = u.id) AS follower_count,
              (cp.verification_status = 'verified' OR u.is_verified) AS is_verified
         FROM users u
         LEFT JOIN creator_profiles cp ON cp.user_id = u.id
        WHERE u.id <> $1
          AND u.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM follows f
             WHERE f.follower_user_id = $1 AND f.following_user_id = u.id
          )
        ORDER BY (u.id = $2) DESC,
                 (cp.id IS NOT NULL) DESC,
                 (SELECT COUNT(*) FROM follows f WHERE f.following_user_id = u.id) DESC,
                 u.created_at ASC
        LIMIT 10`,
      [userId, SWYPIK_OFFICIAL_ID],
    );

    const creators = rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      bio: r.bio,
      followerCount: parseInt(r.follower_count || "0", 10),
      isVerified: Boolean(r.is_verified),
    }));

    return NextResponse.json({ ok: true, creators });
  } catch (error) {
    logger.error({ err: error }, "[suggested-creators] error");
    return NextResponse.json({ ok: false, error: "Internal Server Error" }, { status: 500 });
  }
}
