import { after, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/guard";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { logAdminAction } from "@/lib/security/admin-audit";
import { logger } from "@/lib/logger";
import { executeNewsPipeline, startNewsRun } from "@/lib/news/pipeline-run";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/news/run — „Rulează acum” din /admin/news.
 * Pipeline-ul poate dura minute (feed-uri + N rezumate AI), peste limita de
 * 100 s a Cloudflare (524). Răspundem imediat 202 { runId } și rulăm în fundal
 * (`after`); rezultatul ajunge în cron_runs, pe care pagina îl urmărește.
 */
export const POST = withErrorHandling(async function POST(req: Request) {
  if (!isEnabled("news")) return frozenResponse("news");
  const auth = await requireAdmin(req, "content");
  if (auth instanceof NextResponse) return auth;

  const rl = await rateLimit("newsPipeline", `admin:${auth.userId ?? "unknown"}`);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const runId = await startNewsRun("admin");
  after(() =>
    executeNewsPipeline({ triggeredBy: "admin", runId }).then(
      () => undefined,
      (err: unknown) => logger.error({ err, runId }, "[admin/news/run] background run failed"),
    ),
  );
  await logAdminAction({ action: "news_pipeline.run", targetType: "news_pipeline", targetId: runId ?? "none", details: {}, actor: auth, req });
  return NextResponse.json({ runId, status: "running" }, { status: 202 });
});
