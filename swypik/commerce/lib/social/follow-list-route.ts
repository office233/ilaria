/** Handler comun pentru GET /api/users/[id]/followers și /following (cursor). */
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { SOCIAL_PAGE } from "./config";
import { decodeCursor, pageLimit } from "./cursor";
import { listFollows } from "./follows";

export async function handleFollowList(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  direction: "followers" | "following",
) {
  try {
    const { id } = await params;
    if (!isUuidParam(id)) return invalidIdResponse();
    const url = new URL(req.url);
    const cursor = url.searchParams.get("cursor");
    if (cursor && !decodeCursor(cursor)) return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
    const limit = pageLimit(url.searchParams.get("limit"), SOCIAL_PAGE.follows, SOCIAL_PAGE.maxPage);
    const viewerId = await getOptionalSocialUserId().catch(() => null);
    const page = await listFollows(id, direction, { viewerId, cursor, limit });
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error({ err: error, direction }, "[follow-list] failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
