import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/guard";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { parseBody } from "@/lib/validation/schemas";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { logAdminAction } from "@/lib/security/admin-audit";
import { ADMIN_NEWS_STATUSES, setArticleStatus } from "@/lib/news/admin-repository";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({ status: z.enum(ADMIN_NEWS_STATUSES) });

/** PATCH /api/admin/news/:id { status } — publish a reviewed draft, archive, or send back to draft. */
export const PATCH = withErrorHandling(async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isEnabled("news")) return frozenResponse("news");
  const auth = await requireAdmin(req, "content");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const parsed = parseBody(PatchSchema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const res = await setArticleStatus(id, parsed.data.status, auth.userId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.error === "not_found" ? 404 : 422 });

  await logAdminAction({ action: "news_article.status", targetType: "news_article", targetId: id, details: { status: parsed.data.status }, actor: auth, req });
  return NextResponse.json({ article: res.row });
});
