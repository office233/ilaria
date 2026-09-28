/**
 * GET /api/ready — readiness pentru rolling deploy / load balancer.
 *
 * 200 doar dacă replica poate servi trafic: Postgres și Redis răspund (ambele
 * partajate de toate replicile) și replica nu e în oprire (SIGTERM → 503
 * imediat, ca balansarea să o scoată din rotație). Ieftin (fără R2/email, spre
 * deosebire de /api/health) — potrivit pentru healthcheck-ul containerului.
 */
import { NextResponse } from "next/server";
import { checkDb, checkRedis } from "@/lib/health";
import { isDraining, openLongLivedConnections } from "@/lib/runtime/shutdown";
import { releaseInfo, replicaInfo } from "@/lib/runtime/replica";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const draining = isDraining();
  const [db, redis] = draining ? [null, null] : await Promise.all([checkDb(), checkRedis()]);
  const ready = !draining && db?.status !== "error" && redis?.status !== "error" && redis?.detail?.reason !== "not_configured";
  return NextResponse.json(
    {
      ready,
      draining,
      replica: replicaInfo(),
      commit: releaseInfo().commit,
      checks: { database: db?.status ?? "skipped", redis: redis?.status ?? "skipped" },
      sse_connections: openLongLivedConnections(),
    },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
