/**
 * FRONT R5 — GET /api/couriers/earnings
 *
 * Câștigurile curierului logat (din wallet_ledger_entries), agregate pe
 * perioade (azi / săptămâna asta / luna asta) și pe sursă:
 *   eats  = ref_type 'order'   (creditări livrări card − debite decont cash)
 *   go    = ref_type 'ride'    (creditări curse card − debite comision cash)
 *   tips  = bacșișul e inclus în creditări (metadata.split.tip_cents) —
 *           raportat separat, informativ.
 *
 * Plus: soldul curent (poate fi negativ = datorie comision cash) și
 * cererile de payout recente.
 */
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { getBalanceCents } from "@/lib/wallet/ledger";
import { DEFAULT_CURRENCY } from "@/lib/i18n/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Bucket = { eats_cents: number; go_cents: number; tips_cents: number; net_cents: number };

function emptyBucket(): Bucket {
  return { eats_cents: 0, go_cents: 0, tips_cents: 0, net_cents: 0 };
}

export const GET = withErrorHandling(async function GET() {
  const session = await getAuthSession();
  if (!session?.userId) {
    return NextResponse.json({ error: "unauthorized", code: "unauthorized" }, { status: 401 });
  }

  const { rows: courierRows } = await dbQuery<{ id: string }>(
    `SELECT id FROM couriers WHERE user_id = $1`,
    [session.userId],
  );
  if (!courierRows[0]) {
    return NextResponse.json({ error: "not_a_courier", code: "not_a_courier" }, { status: 403 });
  }

  const { rows } = await dbQuery<{
    period: string;
    ref_type: string;
    kind: string;
    total: string;
    tips: string;
  }>(
    `SELECT p.period, e.ref_type, e.kind,
            COALESCE(SUM(e.amount_cents), 0)::text AS total,
            COALESCE(SUM((e.metadata -> 'split' ->> 'tip_cents')::bigint) FILTER (WHERE e.kind = 'credit'), 0)::text AS tips
       FROM wallet_ledger_entries e
       CROSS JOIN LATERAL (
         SELECT unnest(ARRAY['today','week','month']) AS period
       ) p
      WHERE e.user_id = $1
        AND e.ref_type IN ('ride', 'order', 'ride_cancel_fee')
        AND e.created_at >= CASE p.period
              WHEN 'today' THEN date_trunc('day', now())
              WHEN 'week'  THEN date_trunc('week', now())
              ELSE              date_trunc('month', now())
            END
      GROUP BY p.period, e.ref_type, e.kind`,
    [session.userId],
  );

  const periods: Record<string, Bucket> = {
    today: emptyBucket(),
    week: emptyBucket(),
    month: emptyBucket(),
  };
  for (const r of rows) {
    const b = periods[r.period];
    if (!b) continue;
    const signed = (r.kind === "credit" ? 1 : -1) * Number(r.total);
    if (r.ref_type === "order") b.eats_cents += signed;
    else if (r.ref_type === "ride" || r.ref_type === "ride_cancel_fee") b.go_cents += signed;
    b.net_cents += signed;
    if (r.kind === "credit") b.tips_cents += Number(r.tips);
  }

  const balance_cents = await getBalanceCents(session.userId);

  // Lista ultimelor livrări/curse cu suma per fiecare (din ledger).
  const { rows: entries } = await dbQuery(
    `SELECT e.id::text, e.kind, e.amount_cents::int8 AS amount_cents, e.ref_type, e.ref_id,
            e.description, e.created_at,
            (e.metadata -> 'split' ->> 'tip_cents')::bigint AS tip_cents
       FROM wallet_ledger_entries e
      WHERE e.user_id = $1
        AND e.ref_type IN ('ride', 'order', 'ride_cancel_fee', 'payout', 'payout_refund')
      ORDER BY e.created_at DESC
      LIMIT 50`,
    [session.userId],
  );

  const { rows: payouts } = await dbQuery(
    `SELECT id, amount_cents::int8 AS amount_cents, status, requested_at, resolved_at
       FROM payout_requests
      WHERE user_id = $1
      ORDER BY requested_at DESC
      LIMIT 10`,
    [session.userId],
  );

  // 2026-08-11 (audit): pragul minim de payout expus în API ca UI-ul să fie
  // sincronizat cu env (PAYOUT_MIN_CENTS) — înainte era hardcodat și în client.
  const minPayoutCents =
    Number(process.env.PAYOUT_MIN_CENTS) > 0
      ? Math.trunc(Number(process.env.PAYOUT_MIN_CENTS))
      : 5000;

  return NextResponse.json({
    balance_cents,
    periods,
    entries,
    payouts,
    currency: DEFAULT_CURRENCY,
    min_payout_cents: minPayoutCents,
  });
});
