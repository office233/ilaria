import { NextResponse } from "next/server";
import { z } from "zod";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { parseBody } from "@/lib/validation/schemas";
import { NEWS_COMMENT_REPORT_REASONS, publishedArticleIdForSlug, reportNewsComment } from "@/lib/news/comment-moderation";

export const dynamic = "force-dynamic";

const Schema = z.object({ reason: z.enum(NEWS_COMMENT_REPORT_REASONS).default("other") });

/** POST /api/news/[slug]/comments/[id]/report { reason } — raport către moderare. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  if (!isEnabled("news")) return frozenResponse("news");
  const user = await getAuthUser();
  if (!user.userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("newsCommentReport", user.userId, { limit: 10, window: 600 });
  if (!rl.success) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });

  const { slug, id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const parsed = parseBody(Schema, await req.json().catch(() => ({})));
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  const articleId = await publishedArticleIdForSlug(slug);
  if (!articleId) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const res = await reportNewsComment(articleId, id, user.userId, parsed.data.reason);
  if (!res.ok) return NextResponse.json({ ok: false, error: res.code }, { status: res.code === "not_found" ? 404 : 422 });
  return NextResponse.json({ ok: true }, { status: 201 });
}
