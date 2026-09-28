import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/guard";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { ADMIN_NEWS_STATUSES, getNewsHealthCounts, listArticlesForAdmin, type AdminNewsStatus } from "@/lib/news/admin-repository";
import { listRecentNewsRuns } from "@/lib/news/pipeline-run";
import { getNewsAiConfig, getNewsPublishMode } from "@/lib/news/config";

export const dynamic = "force-dynamic";

const PAGE = 50;

/**
 * GET /api/admin/news?status=draft|published|archived&offset= — review queue + archive
 * + sănătatea pipeline-ului (surse active, ultimele rulări din cron_runs, erori).
 */
export const GET = withErrorHandling(async function GET(req: Request) {
  if (!isEnabled("news")) return frozenResponse("news");
  const auth = await requireAdmin(req, "content");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const raw = url.searchParams.get("status");
  const status: AdminNewsStatus = (ADMIN_NEWS_STATUSES as readonly string[]).includes(raw ?? "") ? (raw as AdminNewsStatus) : "draft";
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0));

  const [articles, counts, runs] = await Promise.all([
    listArticlesForAdmin(status, PAGE, offset),
    getNewsHealthCounts(),
    listRecentNewsRuns(5),
  ]);
  return NextResponse.json({
    articles,
    publishMode: getNewsPublishMode(),
    aiConfigured: getNewsAiConfig() !== null,
    health: { ...counts, runs },
  });
});
