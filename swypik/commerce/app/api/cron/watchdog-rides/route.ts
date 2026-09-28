/**
 * GET|POST /api/cron/watchdog-rides
 *
 * Watchdog Swypik Go — plasa de siguranță dacă dispatch-worker moare:
 *  0. Curse card neautorizate peste go_settings.payment_auth_ttl_minutes → anulate.
 *  1. Curse blocate în 'requested'/'searching' peste RIDES_WATCHDOG_STALE_MIN
 *     (default 15 min) → anulate ca 'system' (no_driver_timeout), iar jobul
 *     de dispatch aferent e închis.
 *  2. Curse 'accepted'/'arriving' fără progres peste RIDES_WATCHDOG_ACTIVE_MIN
 *     (default 120 min) → doar raportate (nu anulăm curse posibil în derulare).
 *
 * Auth: x-cron-secret / Bearer CRON_SECRET (timingSafeEqual).
 * Frecvență recomandată: la 5 minute (cron-worker run.sh).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { dbQuery } from "@/lib/db";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { logger } from "@/lib/logger";
import { getGoSettings } from "@/lib/rides/settings";
import { cancelRideAuthorization } from "@/lib/payments/mobility-stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger.child({ route: "cron/watchdog-rides" });

const STALE_MIN = Number(process.env.RIDES_WATCHDOG_STALE_MIN ?? 15);
const ACTIVE_MIN = Number(process.env.RIDES_WATCHDOG_ACTIVE_MIN ?? 120);

function authorize(req: Request) {
  const token =
    req.headers.get("authorization")?.replace("Bearer ", "") ||
    req.headers.get("x-cron-secret") ||
    "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !token) return false;
  if (Buffer.byteLength(token) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

async function runWatchdog() {
  // 0) Curse card neautorizate (pasagerul n-a confirmat plata) → anulare după TTL.
  const settings = await getGoSettings();
  const unpaid = await dbQuery<{ id: string }>(
    `UPDATE rides
        SET status = 'cancelled', cancelled_by = 'system', cancel_reason = 'payment_not_authorized',
            cancelled_at = now(), updated_at = now(), cancel_fee_cents = 0
      WHERE status = 'requested' AND payment_method = 'card' AND payment_status = 'unpaid'
        AND requested_at < now() - ($1::int * INTERVAL '1 minute')
      RETURNING id`,
    [settings.payment_auth_ttl_minutes],
  );
  for (const r of unpaid.rows) await cancelRideAuthorization(r.id);

  // 1) Curse fără șofer, blocate în requested/searching → anulare system.
  const cancelled = await dbQuery<{ id: string; job_id: string | null }>(
    `UPDATE rides
        SET status = 'cancelled',
            cancelled_by = 'system',
            cancel_reason = 'no_driver_timeout',
            cancelled_at = now(),
            updated_at = now()
      WHERE status IN ('requested', 'searching')
        AND requested_at < now() - ($1::int * INTERVAL '1 minute')
      RETURNING id, job_id`,
    [STALE_MIN]
  );

  // Hold-urile pe card ale curselor anulate se eliberează.
  for (const r of cancelled.rows) await cancelRideAuthorization(r.id);

  // Închide joburile de dispatch aferente (dacă mai sunt active).
  const jobIds = cancelled.rows.map((r) => r.job_id).filter(Boolean);
  if (jobIds.length) {
    await dbQuery(
      `UPDATE dispatch_jobs
          SET status = 'no_courier', updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'searching'`,
      [jobIds]
    );
  }

  // 2) Curse active suspect de vechi — doar raportare.
  const staleActive = await dbQuery<{ id: string; status: string }>(
    `SELECT id, status FROM rides
      WHERE status IN ('accepted', 'arriving', 'in_progress')
        AND updated_at < now() - ($1::int * INTERVAL '1 minute')
      LIMIT 50`,
    [ACTIVE_MIN]
  );
  if (staleActive.rows.length) {
    log.warn(
      { count: staleActive.rows.length, ids: staleActive.rows.map((r) => r.id) },
      "rides active fara progres — verificare manuala"
    );
  }

  return {
    cancelled_unpaid: unpaid.rows.length,
    cancelled_no_driver: cancelled.rows.length,
    dispatch_jobs_closed: jobIds.length,
    stale_active_reported: staleActive.rows.length,
  };
}

async function handle(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await runCron("watchdog-rides", runWatchdog);
  if (result === null) return cronSkippedResponse("watchdog-rides");
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handle;
export const POST = handle;
