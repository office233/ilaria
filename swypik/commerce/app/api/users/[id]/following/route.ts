import { handleFollowList } from "@/lib/social/follow-list-route";

export const dynamic = "force-dynamic";

export const GET = (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  handleFollowList(req, ctx, "following");
