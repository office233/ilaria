import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  title: string | null;
  thumbnail_url: string | null;
  duration_ms: number | null;
  like_count: string | number | null;
  view_count: string | number | null;
  visibility: string;
  status: string;
  creator_id: string | null;
  creator_username: string | null;
  creator_display_name: string | null;
  creator_avatar: string | null;
  saved_at: string;
};

async function GET_impl(request: Request) {
  const user = await getAuthUser();
  if (!user.userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") || "50", 10);
  const offsetParam = Number.parseInt(url.searchParams.get("offset") || "0", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 50, 1), 100);
  const offset = Math.max(Number.isFinite(offsetParam) ? offsetParam : 0, 0);

  const { rows } = await dbQuery<Row>(
    `SELECT v.id,
            v.title,
            v.thumbnail_url,
            v.duration_ms,
            v.like_count,
            v.view_count,
            v.visibility,
            v.status,
            v.creator_id,
            u.username AS creator_username,
            u.display_name AS creator_display_name,
            u.avatar_url AS creator_avatar,
            s.created_at AS saved_at
       FROM saves s
       JOIN videos v ON v.id = s.video_id
       LEFT JOIN users u ON u.id = v.creator_id
      WHERE s.user_id = $1
        AND v.status = 'ready'
        AND (v.visibility = 'public' OR v.creator_id = $1)
        AND (v.creator_id = $1 OR v.effective_label = 'safe')
      ORDER BY s.created_at DESC
      LIMIT $2 OFFSET $3`,
    [user.userId, limit, offset],
  );

  const videos = rows.map((r) => ({
    id: r.id,
    title: r.title,
    thumbnail: r.thumbnail_url,
    durationMs: r.duration_ms,
    likeCount: Number(r.like_count || 0),
    viewCount: Number(r.view_count || 0),
    creatorUsername: r.creator_username,
    creatorDisplayName: r.creator_display_name,
    creatorAvatar: r.creator_avatar,
    savedAt: r.saved_at,
  }));

  return NextResponse.json({ ok: true, videos, hasMore: rows.length === limit });
}

export const GET = withErrorHandling(GET_impl);
