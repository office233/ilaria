import { withErrorHandling } from "@/lib/api-handler";
import { NextRequest, NextResponse } from "next/server";
import { checkDb, checkRedis, checkR2, checkQueue } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * GET /api/health/full
 *
 * Detailed health check: DB write/read + Redis + R2 + BullMQ queue.
 * REQUIRES header `x-internal-secret` (or ?secret=…) matching
 * INTERNAL_HEALTH_SECRET / ADMIN_SECRET. Without it, returns a minimal
 * `{status:"ok"}` 200 (sufficient for uptime monitors) and DOES NOT
 * expose internal infrastructure details.
 */
async function GET_impl(req: NextRequest) {
  const want =
    process.env.INTERNAL_HEALTH_SECRET ||
    process.env.ADMIN_SECRET ||
    "";
  const provided =
    req.headers.get("x-internal-secret") ||
    new URL(req.url).searchParams.get("secret") ||
    "";
  if (!want || provided !== want) {
    return NextResponse.json(
      { status: "ok", timestamp: new Date().toISOString() },
      { status: 200 },
    );
  }

  const startedAt = Date.now();

  const [dbWrite, dbRead, redis, r2, queue] = await Promise.all([
    checkDb(),
    checkDb(),
    checkRedis(),
    checkR2(),
    checkQueue(),
  ]);

  const overall =
    [dbWrite, dbRead, redis, r2, queue].some((r) => r.status === "error")
      ? "error"
      : [dbWrite, dbRead, redis, r2, queue].some((r) => r.status === "degraded")
        ? "degraded"
        : "ok";

  return NextResponse.json(
    {
      status: overall,
      timestamp: new Date().toISOString(),
      total_latency_ms: Date.now() - startedAt,
      db_write: dbWrite,
      db_read: dbRead,
      redis,
      r2,
      queue,
    },
    { status: overall === "error" ? 503 : 200 },
  );
}

export const GET = withErrorHandling(GET_impl);
