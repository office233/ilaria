import { cronSkippedResponse } from "@/lib/cron/lock";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { executeNewsPipeline } from "@/lib/news/pipeline-run";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { isAdminRequest } from "@/lib/security/admin-auth";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Same timing-safe CRON_SECRET check as app/api/cron/refresh-rank/route.ts.
 * Kept local (rather than extracted to a shared helper) because this route
 * is the only one under YOUR FILES scope — refresh-rank's copy stays
 * untouched to avoid a cross-agent collision on a file another agent owns.
 */
function authorizeCronRequest(request: NextRequest): boolean {
  const expectedSecret = process.env.CRON_SECRET || "";
  const authorization = request.headers.get("authorization") || "";
  const bearerToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const providedSecret =
    bearerToken ||
    request.headers.get("x-cron-secret") ||
    request.headers.get("cron-secret") ||
    "";

  if (!expectedSecret || !providedSecret) return false;
  if (Buffer.byteLength(providedSecret) !== Buffer.byteLength(expectedSecret)) return false;
  return timingSafeEqual(Buffer.from(providedSecret), Buffer.from(expectedSecret));
}

/**
 * POST/GET /api/cron/news-pipeline
 *
 * Triggers the AI news ingestion pipeline (lib/news/rss-ingester.ts).
 * Auth: either
 *   - header `x-cron-secret` / `cron-secret` / `Authorization: Bearer <CRON_SECRET>`
 *     matching the CRON_SECRET env var (scheduled cron caller), OR
 *   - an authenticated ADMIN request (see lib/security/admin-auth.ts) for
 *     manual/on-demand triggers from the admin panel.
 * Every call — even ones from a legitimate cron/admin caller — is rate
 * limited, since each run can invoke Azure OpenAI up to NEWS_MAX_ARTICLES_PER_RUN
 * times (unbounded cost otherwise).
 */
async function handle(req: NextRequest) {
  if (!isEnabled("news")) return frozenResponse("news");

  const isCron = authorizeCronRequest(req);
  const isAdmin = isCron ? false : await isAdminRequest(req);

  if (!isCron && !isAdmin) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const rlIdentifier = isCron ? "cron" : getClientIP(req);
  const rl = await rateLimit("newsPipeline", rlIdentifier);
  if (!rl.success) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  let targetCategory: string | undefined;
  const urlCat = new URL(req.url).searchParams.get("category");
  if (urlCat) {
    targetCategory = urlCat;
  } else {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.category === "string") targetCategory = body.category.slice(0, 40);
  }

  const triggeredBy = isCron ? "cron" : "admin";
  // Exact-once între replici (advisory lock) + rezultat în cron_runs (vizibil în /admin/news).
  const outcome = await executeNewsPipeline({ triggeredBy, category: targetCategory });
  switch (outcome.kind) {
    case "skipped":
      return cronSkippedResponse("news-pipeline");
    case "not_configured":
      // Vizibil în logurile cron-worker (FAIL status=503) până se setează cheia + modelul.
      return NextResponse.json({ ok: false, error: "news_ai_not_configured", triggeredBy }, { status: 503 });
    case "no_sources":
      return NextResponse.json({ ok: false, error: "news_no_sources", triggeredBy }, { status: 503 });
    case "all_failed":
      // Totul a eșuat (feed-uri sau AI) — alertă, nu un „0 articole” tăcut.
      return NextResponse.json({ ok: false, error: "pipeline_all_failed", ...outcome.result, triggeredBy }, { status: 502 });
    case "crashed":
      return NextResponse.json({ ok: false, error: "pipeline_failed" }, { status: 500 });
    case "ok": {
      const res = outcome.result;
      return NextResponse.json({
        ok: true,
        ingested: res.ingested,
        status: res.status,
        categories: res.categoriesProcessed,
        capped: res.capped,
        duplicates: res.duplicates,
        errors: res.errors,
        triggeredBy,
      });
    }
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
