import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { dbQuery, dbQueryLong } from "@/lib/db";
import { logger } from "@/lib/logger";
import { withCronLock } from "@/lib/cron/lock";

export const dynamic = "force-dynamic";

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
 * POST/GET /api/cron/refresh-rank
 *
 * Refreshes the `video_rank_14d` materialized view used by /api/explore/feed
 * to rank videos based on real engagement (last 14 days of feed_events).
 *
 * Auth: requires header `x-cron-secret` matching CRON_SECRET env var.
 * Schedule externally (cron-job.org / GitHub Action / pg_cron) every 5 minutes.
 */
async function handle(request: NextRequest) {
  if (!authorizeCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Exact-once între replici: o a doua declanșare concurentă iese imediat (200 skipped).
  return withCronLock("refresh-rank", refreshRank);
}

async function refreshRank(): Promise<Response> {
  const startedAt = Date.now();
  try {
    // Try CONCURRENTLY first (zero downtime), fallback to plain REFRESH if not possible.
    try {
      // dbQueryLong: refresh-ul creste cu feed_events si depaseste legitim
      // plafonul de statement_timeout dimensionat pentru cererile userilor.
      await dbQueryLong(`REFRESH MATERIALIZED VIEW CONCURRENTLY video_rank_14d`);
    } catch (e: any) {
      logger.warn({ err: e?.message }, "refresh-rank concurrent failed, falling back");
      await dbQueryLong(`REFRESH MATERIALIZED VIEW video_rank_14d`);
    }
    // Statisticile pe 7 zile ale ranker-ului nou (lib/feed, 20260926_0132).
    // Opțional: lipsa MV-ului (migrare neaplicată) nu strică refresh-ul vechi.
    await dbQueryLong(`REFRESH MATERIALIZED VIEW CONCURRENTLY video_stats_7d`).catch((err: unknown) =>
      logger.warn({ err }, "refresh-rank: video_stats_7d refresh failed"),
    );

    const { rows } = await dbQuery(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE rank_score > 0)::int AS positive,
              MAX(rank_score)::numeric AS max_score
       FROM video_rank_14d`
    );

    const elapsedMs = Date.now() - startedAt;
    const stats = rows[0] || { total: 0, positive: 0, max_score: 0 };

    // cron_runs schema: (job_name, started_at, completed_at, status, duration_ms, result jsonb, error)
    try {
      await dbQuery(
        `INSERT INTO cron_runs (job_name, started_at, completed_at, duration_ms, status, result)
         VALUES ('refresh-rank', NOW() - ($1::text || ' milliseconds')::interval, NOW(), $1::integer, 'success', $2::jsonb)`,
        [elapsedMs, JSON.stringify(stats)]
      );
    } catch (err: any) {
      logger.warn({ err: err?.message }, "refresh-rank: cron_runs insert failed");
    }

    return NextResponse.json({ ok: true, elapsedMs, ...stats });
  } catch (e: any) {
    logger.error({ err: e?.message }, "refresh-rank failed");
    try {
      await dbQuery(
        `INSERT INTO cron_runs (job_name, started_at, completed_at, duration_ms, status, error)
         VALUES ('refresh-rank', NOW() - ($1::text || ' milliseconds')::interval, NOW(), $1::integer, 'failed', $2)`,
        [Date.now() - startedAt, String(e?.message || e).slice(0, 500)]
      );
    } catch {
      /* ignore secondary failure */
    }
    return NextResponse.json({ ok: false, error: e?.message || "refresh failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
