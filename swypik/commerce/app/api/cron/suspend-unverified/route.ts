/**
 * Cron Job: Suspend unverified users after the 7-day grace period.
 *
 * Queries users where:
 *   - status = 'active'
 *   - email_verified_at IS NULL
 *   - suspend_grace_until IS NOT NULL AND suspend_grace_until < now()
 *
 * For each match:
 *   - sets status = 'suspended'
 *   - revokes all live sessions
 *
 * Auth: CRON_SECRET (Bearer / x-cron-secret / cron-secret header).
 */

import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { dbQuery } from "@/lib/db";
import { timingSafeEqual } from "crypto";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";

export const dynamic = "force-dynamic";

async function authorize(req: Request) {
  const authHeader = req.headers.get("authorization");
  const token =
    authHeader?.replace("Bearer ", "") ||
    req.headers.get("x-cron-secret") ||
    req.headers.get("cron-secret") ||
    req.headers.get("CRON_SECRET") ||
    "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !token) return false;
  if (Buffer.byteLength(token) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

async function handleGET(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { rows: targets } = await dbQuery<{ id: string; email: string }>(
    `SELECT id, email
     FROM users
     WHERE status = 'active'
       AND email_verified_at IS NULL
       AND suspend_grace_until IS NOT NULL
       AND suspend_grace_until < now()`,
  );

  let suspendedCount = 0;
  for (const u of targets) {
    try {
      await dbQuery(
        `UPDATE users SET status = 'suspended' WHERE id = $1`,
        [u.id],
      );
      await dbQuery(
        `UPDATE user_sessions SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [u.id],
      );
      suspendedCount++;
    } catch (err) {
      logger.warn({ err, email: u.email }, "[cron/suspend-unverified] failed");
    }
  }

  return NextResponse.json({
    success: true,
    suspended: suspendedCount,
    candidates: targets.length,
  });
}

export async function GET(req: Request) {
  const res = await runCron("suspend-unverified", () => handleGET(req as any));
  return res ?? cronSkippedResponse("suspend-unverified");
}
