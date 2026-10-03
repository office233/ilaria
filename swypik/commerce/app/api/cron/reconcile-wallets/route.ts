/**
 * FRONT R5 — GET|POST /api/cron/reconcile-wallets
 *
 * Reconciliere zilnică:
 *  1. sum(wallet_ledger_entries) per user == wallet_balances.balance_cents;
 *  2. rides completed (>10 min) fără intrare în ledger (ref 'ride') și fără
 *     settled_at → decontare lipsă;
 *  3. local_orders delivered (>10 min) cu curier, fără intrare (ref 'order').
 *
 * Problemele se scriu în reconciliation_issues (unic pe (kind, ref_id) cât
 * timp sunt nerezolvate) + log de alertă.
 *
 * Auth: x-cron-secret / Bearer CRON_SECRET (același model ca dispatch-tick).
 * Frecvență recomandată: zilnic (ex. 04:00).
 */
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { timingSafeEqual } from "node:crypto";
import { dbQuery } from "@/lib/db";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger.child({ cron: "reconcile-wallets" });

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function reportIssue(kind: string, refId: string, details: Record<string, unknown>) {
  await dbQuery(
    `INSERT INTO reconciliation_issues (kind, ref_id, details)
     VALUES ($1, $2, $3)
     ON CONFLICT (kind, ref_id) WHERE resolved = false DO NOTHING`,
    [kind, refId, JSON.stringify(details)],
  );
  log.error({ kind, refId, details }, "RECONCILIATION ISSUE");
}

async function reconcile() {
  let balanceMismatches = 0;
  let unsettledRides = 0;
  let unsettledOrders = 0;

  // 1. Sold vs sumă ledger.
  const { rows: mismatches } = await dbQuery<{
    user_id: string;
    balance_cents: string;
    ledger_sum: string;
  }>(
    `SELECT wb.user_id, wb.balance_cents::text,
            COALESCE(SUM(CASE WHEN e.kind = 'credit' THEN e.amount_cents ELSE -e.amount_cents END), 0)::text AS ledger_sum
       FROM wallet_balances wb
       LEFT JOIN wallet_ledger_entries e ON e.user_id = wb.user_id
      GROUP BY wb.user_id, wb.balance_cents
     HAVING wb.balance_cents <> COALESCE(SUM(CASE WHEN e.kind = 'credit' THEN e.amount_cents ELSE -e.amount_cents END), 0)`,
  );
  for (const m of mismatches) {
    balanceMismatches++;
    await reportIssue("balance_mismatch", m.user_id, {
      balance_cents: Number(m.balance_cents),
      ledger_sum: Number(m.ledger_sum),
    });
  }

  // 2. Curse completed fără decontare (lăsăm 10 min de grație post-completare).
  const { rows: rides } = await dbQuery<{ id: string; completed_at: string }>(
    `SELECT r.id, r.completed_at::text
       FROM rides r
       JOIN couriers c ON c.id = r.driver_id
      WHERE r.status = 'completed'
        AND r.completed_at < now() - interval '10 minutes'
        AND r.settled_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries e
           WHERE e.ref_type = 'ride' AND e.ref_id = r.id::text
        )`,
  );
  for (const r of rides) {
    unsettledRides++;
    await reportIssue("unsettled_ride", r.id, { completed_at: r.completed_at });
  }

  // 3. Comenzi delivered fără decontare.
  const { rows: orders } = await dbQuery<{ id: string; delivered_at: string }>(
    `SELECT lo.id, lo.delivered_at::text
       FROM local_orders lo
      WHERE lo.status = 'delivered'
        AND lo.courier_id IS NOT NULL
        AND lo.delivered_at < now() - interval '10 minutes'
        AND lo.settled_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries e
           WHERE e.ref_type = 'order' AND e.ref_id = lo.id::text
        )`,
  );
  for (const o of orders) {
    unsettledOrders++;
    await reportIssue("unsettled_order", o.id, { delivered_at: o.delivered_at });
  }

  // 4. Decontări făcute FĂRĂ ca platforma să fi încasat. Audit 2026-09:
  // decontarea alegea ramura după `payment_method` fără să verifice vreodată
  // `payment_status`, deci comenzile card_online neplătite și cursele card
  // necapturate creditau curierul/șoferul din fondurile platformei.
  // `lib/payments/fund-custody.ts` blochează asta pentru cazurile noi; aici
  // prindem ce a apucat să treacă înainte de patch. Banii sunt deja în ledger,
  // deci corecția e o decizie umană (stornare vs. acoperire).
  let settledUnpaid = 0;

  const { rows: paidOutUnpaidOrders } = await dbQuery<{
    id: string; payment_status: string; delivered_at: string; amount_cents: string;
  }>(
    `SELECT lo.id, lo.payment_status, lo.delivered_at::text,
            COALESCE(SUM(e.amount_cents), 0)::text AS amount_cents
       FROM local_orders lo
       JOIN wallet_ledger_entries e
         ON e.ref_type = 'order' AND e.ref_id = lo.id::text AND e.kind = 'credit'
      WHERE lo.status = 'delivered'
        AND lo.payment_method = 'card_online'
        AND lo.payment_status <> 'paid'
      GROUP BY lo.id, lo.payment_status, lo.delivered_at`,
  );
  for (const o of paidOutUnpaidOrders) {
    settledUnpaid++;
    await reportIssue("settled_without_payment_order", o.id, {
      payment_status: o.payment_status,
      delivered_at: o.delivered_at,
      credited_cents: Number(o.amount_cents),
    });
  }

  const { rows: paidOutUnpaidRides } = await dbQuery<{
    id: string; payment_method: string | null; payment_status: string; amount_cents: string;
  }>(
    `SELECT r.id, r.payment_method, r.payment_status,
            COALESCE(SUM(e.amount_cents), 0)::text AS amount_cents
       FROM rides r
       JOIN wallet_ledger_entries e
         ON e.ref_type = 'ride' AND e.ref_id = r.id::text AND e.kind = 'credit'
      WHERE r.status = 'completed'
        AND COALESCE(r.payment_method, 'cash') <> 'cash'
        AND r.payment_status <> 'captured'
      GROUP BY r.id, r.payment_method, r.payment_status`,
  );
  for (const r of paidOutUnpaidRides) {
    settledUnpaid++;
    await reportIssue("settled_without_payment_ride", r.id, {
      payment_method: r.payment_method,
      payment_status: r.payment_status,
      credited_cents: Number(r.amount_cents),
    });
  }

  const summary = { balanceMismatches, unsettledRides, unsettledOrders, settledUnpaid };
  log.info(summary, "wallet reconciliation done");
  return summary;
}

async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runCron("reconcile-wallets", reconcile);
  if (result === null) return cronSkippedResponse("reconcile-wallets");
  return NextResponse.json({ success: true, ...result });
}

export const GET = withErrorHandling(async function GET(req: Request) {
  return handle(req);
});
export const POST = withErrorHandling(async function POST(req: Request) {
  return handle(req);
});
