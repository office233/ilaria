import { NextResponse } from "next/server";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { blockNewsCommentAuthor, publishedArticleIdForSlug } from "@/lib/news/comment-moderation";

export const dynamic = "force-dynamic";

/**
 * POST /api/news/[slug]/comments/[id]/block — blochează autorul comentariului
 * (user_blocks): comentariile voastre se ascund reciproc. Autorul e găsit pe
 * server după id-ul comentariului — clientul nu vede user_id-uri.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  if (!isEnabled("news")) return frozenResponse("news");
  const user = await getAuthUser();
  if (!user.userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("newsCommentBlock", user.userId, { limit: 20, window: 600 });
  if (!rl.success) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });

  const { slug, id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const articleId = await publishedArticleIdForSlug(slug);
  if (!articleId) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const res = await blockNewsCommentAuthor(articleId, id, user.userId);
  if (!res.ok) return NextResponse.json({ ok: false, error: res.code }, { status: res.code === "not_found" ? 404 : 422 });
  return NextResponse.json({ ok: true });
}
