/**
 * POST /api/cron/strikes-decay
 *
 * Fades old strikes (status='expired' when past expires_at) and rebuilds
 * `user_risk_scores`. Also auto-lifts suspensions where suspended_until
 * has passed. Runs once per day via cron-worker.
 *
 * Auth: Bearer ${CRON_SECRET}.
 */

import { withCronLock } from "@/lib/cron/lock";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

function authorizeCronRequest(req: Request): boolean {
  const expectedSecret = process.env.CRON_SECRET || "";
  const authorization = req.headers.get("authorization") || "";
  const bearerToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const providedSecret =
    bearerToken ||
    req.headers.get("x-cron-secret") ||
    req.headers.get("cron-secret") ||
    "";

  if (!expectedSecret || !providedSecret) return false;
  if (Buffer.byteLength(providedSecret) !== Buffer.byteLength(expectedSecret)) return false;
  return timingSafeEqual(Buffer.from(providedSecret), Buffer.from(expectedSecret));
}

export async function POST(req: Request) {
  if (!authorizeCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Exact-once între replici: o a doua declanșare concurentă iese imediat (200 skipped).
  return withCronLock("strikes-decay", decayStrikes);
}

async function decayStrikes(): Promise<Response> {
  const start = Date.now();
  try {
    const { rows } = await dbQuery<{ expired: number; recomputed: number }>(
      "SELECT * FROM decay_user_strikes()",
    );
    const expired = Number(rows[0]?.expired ?? 0);
    const recomputed = Number(rows[0]?.recomputed ?? 0);

    const { rows: lifted } = await dbQuery<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM users
        WHERE status = 'active'
          AND suspended_until IS NULL
          AND updated_at > now() - INTERVAL '1 minute'
          AND id IN (
            SELECT user_id FROM user_risk_scores WHERE score > 0
          )`,
    );

    await dbQuery(
      `INSERT INTO cron_runs (job_name, status, duration_ms, completed_at, result)
       VALUES ($1, 'success', $2, NOW(), $3::jsonb)`,
      [
        "strikes-decay",
        Date.now() - start,
        JSON.stringify({ expired, recomputed, suspensions_lifted: Number(lifted[0]?.n ?? 0) }),
      ],
    ).catch(() => undefined);

    return NextResponse.json({
      ok: true,
      elapsedMs: Date.now() - start,
      expired,
      recomputed,
    });
  } catch (err) {
    logger.error({ err }, "[cron/strikes-decay] failed");
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

/** Alias GET — orchestratorul zilnic apelează prin GET, ca restul joburilor. */
export async function GET(req: Request) {
  return POST(req);
}
