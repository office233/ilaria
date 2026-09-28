/**
 * GET /api/users/profile/[username]/videos?tab=videos|liked|saved&cursor=&limit=
 *   → { items, nextCursor }
 * „liked" doar pentru proprietar sau dacă users.liked_videos_public; „saved" doar proprietarul.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { SOCIAL_PAGE } from "@/lib/social/config";
import { decodeCursor, pageLimit } from "@/lib/social/cursor";
import { canViewTab, listProfileVideos, PROFILE_TABS, type ProfileTab } from "@/lib/social/profile/videos";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { normalizeProfileUsername } from "@/lib/social/user-profile";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ username: string }> };

function isTab(value: string | null): value is ProfileTab {
  return PROFILE_TABS.includes(value as ProfileTab);
}

export async function GET(req: Request, { params }: RouteContext) {
  try {
    const { username: raw } = await params;
    const username = normalizeProfileUsername(raw);
    if (!username) return NextResponse.json({ error: "user_not_found" }, { status: 404 });
    const url = new URL(req.url);
    const tabParam = url.searchParams.get("tab") ?? "videos";
    if (!isTab(tabParam)) return NextResponse.json({ error: "invalid_tab" }, { status: 400 });
    const cursor = url.searchParams.get("cursor");
    if (cursor && !decodeCursor(cursor)) return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
    const limit = pageLimit(url.searchParams.get("limit"), SOCIAL_PAGE.videos, SOCIAL_PAGE.maxPage);

    const { rows } = await dbQuery<{ id: string; liked_videos_public: boolean }>(
      `SELECT id, liked_videos_public FROM users WHERE lower(username) = $1 AND status = 'active' LIMIT 1`,
      [username],
    );
    const owner = rows[0];
    if (!owner) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

    const viewerId = tabParam === "videos" ? null : await getOptionalSocialUserId().catch(() => null);
    const allowed = canViewTab(tabParam, {
      isOwner: viewerId === owner.id,
      likedVideosPublic: Boolean(owner.liked_videos_public),
    });
    if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const page = await listProfileVideos(tabParam, owner.id, { cursor, limit });
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    logger.error({ err }, "[User Videos API] GET");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
