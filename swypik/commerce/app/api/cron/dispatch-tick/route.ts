/**
 * GET|POST /api/cron/dispatch-tick
 *
 * Rulează un tick al motorului de dispatch: expiră ofertele fără răspuns,
 * avansează valurile (2 → 5 → 10 km) și marchează joburile fără curier.
 *
 * Auth: header `x-cron-secret` (sau `Authorization: Bearer <secret>`) egal cu
 * env `CRON_SECRET`, comparat cu timingSafeEqual.
 *
 * Frecvență recomandată: la fiecare 10 secunde. Cron-ul de sistem are
 * granularitate de 1 minut, așa că se folosește worker-ul dedicat:
 *
 *   node scripts/dispatch-worker.mjs
 *     (env: DISPATCH_TICK_URL, CRON_SECRET, DISPATCH_TICK_INTERVAL_MS=10000)
 *
 * Alternativ, cu cron clasic (rezoluție 1 min):
 *   * * * * * curl -fsS -H "x-cron-secret: $CRON_SECRET" \
 *       https://swypik.ro/api/cron/dispatch-tick > /dev/null
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { tick } from "@/lib/dispatch/engine";
import { logger } from "@/lib/logger";
import { withCronLock } from "@/lib/cron/lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorizeCronRequest(req: Request): boolean {
  const expectedSecret = process.env.CRON_SECRET || "";
  const authorization = req.headers.get("authorization") || "";
  const bearerToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const providedSecret = req.headers.get("x-cron-secret") || bearerToken || "";

  if (!expectedSecret || !providedSecret) return false;
  if (Buffer.byteLength(providedSecret) !== Buffer.byteLength(expectedSecret)) return false;
  return timingSafeEqual(Buffer.from(providedSecret), Buffer.from(expectedSecret));
}

async function handle(req: Request) {
  if (!authorizeCronRequest(req)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  // Singleton global: dispatch-worker poate rula pe mai multe VM-uri (sau
  // cron-worker + dispatch-worker simultan) — un singur tick avansează valurile
  // la un moment dat, restul primesc 200 skipped. Fără audit în cron_runs
  // (un tick la 10 s ar umple tabela).
  return withCronLock("dispatch-tick", async () => {
    try {
      const result = await tick();
      return NextResponse.json({ success: true, ...result });
    } catch (err) {
      logger.error({ err }, "[cron/dispatch-tick] failed");
      return NextResponse.json({ success: false, error: "tick_failed" }, { status: 500 });
    }
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
