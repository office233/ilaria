/**
 * Retrageri pentru creatori, din portofelul RON (sursa unică a câștigurilor).
 *
 * Cerere (creator): suma se DEBITEAZĂ imediat (ref 'payout:{id}') ca să nu poată
 * fi cerută de două ori; o singură cerere deschisă per utilizator.
 * Rezolvare (admin):
 *   - 'paid' + Stripe Connect disponibil (FEATURE_STRIPE_CONNECT + STRIPE_SECRET_KEY)
 *     și contul creatorului are payouts activ → transfer Stripe (idempotent);
 *   - 'paid' fără Connect → adminul confirmă transferul bancar manual (IBAN);
 *   - 'rejected' → suma revine în portofel (ref 'payout_refund:{id}').
 */
import { dbQuery } from "@/lib/db";
import { isEnabled } from "@/lib/feature-flags";
import { getStripe } from "@/lib/stripe/checkout";
import { creditUser, debitUser, InsufficientFundsError } from "@/lib/wallet/ledger";
import { logger } from "@/lib/logger";
import { notifyLocalized } from "@/lib/notifications/localized";
import { missionPrizeHoldDays } from "@/lib/missions/config";

export function creatorPayoutMinCents(): number {
  const raw = Number(process.env.CREATOR_PAYOUT_MIN_CENTS ?? process.env.PAYOUT_MIN_CENTS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 5_000;
}

export function stripeConnectAvailable(): boolean {
  return isEnabled("stripeConnect") && !!process.env.STRIPE_SECRET_KEY;
}

export type PayoutReadiness = {
  method: "stripe" | "bank";
  connectAvailable: boolean;
  connectAccountReady: boolean;
  minCents: number;
};

export async function getPayoutReadiness(userId: string): Promise<PayoutReadiness & { accountId: string | null }> {
  const { rows } = await dbQuery<{ id: string | null; ready: boolean | null }>(
    `SELECT stripe_connect_account_id AS id, stripe_connect_payouts_enabled AS ready FROM users WHERE id = $1`,
    [userId],
  );
  const connectAvailable = stripeConnectAvailable();
  const ready = connectAvailable && !!rows[0]?.id && !!rows[0]?.ready;
  return {
    method: ready ? "stripe" : "bank",
    connectAvailable,
    connectAccountReady: ready,
    minCents: creatorPayoutMinCents(),
    accountId: rows[0]?.id ?? null,
  };
}

export type WithdrawableState = { balanceCents: number; heldCents: number; withdrawableCents: number; holdDays: number };

/**
 * Sold, partea reținută și cât se poate retrage acum. Reținut = premiile de
 * misiune (`mission_prize`) creditate în ultimele MISSION_PRIZE_HOLD_DAYS zile
 * (anti-fraudă: seller care își premiază un cont-marionetă și retrage imediat).
 */
export async function getWithdrawable(userId: string): Promise<WithdrawableState> {
  const holdDays = missionPrizeHoldDays();
  const { rows } = await dbQuery<{ balance: string | null; held: string | null }>(
    `SELECT (SELECT balance_cents FROM wallet_balances WHERE user_id = $1)::text AS balance,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM wallet_ledger_entries
              WHERE user_id = $1 AND kind = 'credit' AND ref_type = 'mission_prize'
                AND created_at > now() - make_interval(days => $2))::text AS held`,
    [userId, holdDays],
  );
  const balanceCents = Math.max(0, Number(rows[0]?.balance ?? 0) || 0);
  const heldCents = Math.min(balanceCents, Math.max(0, Number(rows[0]?.held ?? 0) || 0));
  return { balanceCents, heldCents, withdrawableCents: balanceCents - heldCents, holdDays };
}

export type RequestResult =
  | { ok: true; id: string; method: "stripe" | "bank" }
  | {
      ok: false;
      code: "below_minimum" | "iban_required" | "open_request_exists" | "insufficient_funds" | "funds_on_hold";
      balanceCents?: number;
      withdrawableCents?: number;
    };

export async function requestCreatorPayout(args: { userId: string; amountCents: number; iban: string | null }): Promise<RequestResult> {
  const readiness = await getPayoutReadiness(args.userId);
  if (args.amountCents < readiness.minCents) return { ok: false, code: "below_minimum" };
  if (readiness.method === "bank" && !args.iban) return { ok: false, code: "iban_required" };

  const funds = await getWithdrawable(args.userId);
  if (funds.heldCents > 0 && args.amountCents > funds.withdrawableCents && args.amountCents <= funds.balanceCents) {
    return { ok: false, code: "funds_on_hold", balanceCents: funds.balanceCents, withdrawableCents: funds.withdrawableCents };
  }

  // Garda „o singură cerere deschisă” e dublată în DB de indexul unic parțial
  // uq_payout_requests_user_open (migrarea 20260928_0062): două POST-uri
  // concurente nu mai pot trece amândouă de NOT EXISTS.
  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO payout_requests (user_id, kind, amount_cents, iban, note)
     SELECT $1, 'creator', $2, $3, $4
      WHERE NOT EXISTS (
        SELECT 1 FROM payout_requests WHERE user_id = $1 AND status IN ('pending', 'processing'))
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [args.userId, args.amountCents, readiness.method === "bank" ? args.iban : null, `method:${readiness.method}`],
  );
  const id = rows[0]?.id;
  if (!id) return { ok: false, code: "open_request_exists" };

  try {
    await debitUser({
      userId: args.userId,
      amountCents: args.amountCents,
      refType: "payout",
      refId: id,
      description: "creator_payout_request",
      metadata: { kind: "creator", method: readiness.method },
    });
  } catch (err) {
    await dbQuery(
      `UPDATE payout_requests SET status = 'rejected', admin_note = 'insufficient_funds', resolved_at = now(), resolved_by = 'system'
        WHERE id = $1`,
      [id],
    );
    if (err instanceof InsufficientFundsError) {
      return { ok: false, code: "insufficient_funds", balanceCents: err.balanceCents };
    }
    throw err;
  }
  logger.info({ payoutId: id, userId: args.userId, method: readiness.method }, "creator.payout.requested");
  return { ok: true, id, method: readiness.method };
}

export type PayoutRequestView = {
  id: string;
  amountCents: number;
  status: string;
  iban: string | null;
  adminNote: string | null;
  failureReason: string | null;
  requestedAt: string;
  resolvedAt: string | null;
  stripeTransferId: string | null;
};

export async function listCreatorPayouts(userId: string): Promise<PayoutRequestView[]> {
  const { rows } = await dbQuery<{
    id: string; amount_cents: string; status: string; iban: string | null; admin_note: string | null;
    failure_reason: string | null; requested_at: string; resolved_at: string | null; stripe_transfer_id: string | null;
  }>(
    `SELECT id, amount_cents::text, status, iban, admin_note, failure_reason,
            requested_at::text, resolved_at::text, stripe_transfer_id
       FROM payout_requests
      WHERE user_id = $1 AND kind = 'creator'
      ORDER BY requested_at DESC
      LIMIT 50`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    amountCents: Number(r.amount_cents),
    status: r.status,
    iban: r.iban ? `•••• ${r.iban.slice(-4)}` : null,
    adminNote: r.admin_note,
    failureReason: r.failure_reason,
    requestedAt: r.requested_at,
    resolvedAt: r.resolved_at,
    stripeTransferId: r.stripe_transfer_id,
  }));
}

export type ResolveResult =
  | { ok: true; status: "paid" | "rejected"; via: "stripe" | "bank" | null }
  | { ok: false; code: "not_pending" | "transfer_failed" | "iban_missing" };

export async function resolveCreatorPayout(args: { id: string; action: "paid" | "rejected"; note: string | null }): Promise<ResolveResult> {
  const { rows } = await dbQuery<{ id: string; user_id: string; amount_cents: string; iban: string | null }>(
    `UPDATE payout_requests SET status = 'processing', admin_note = $2
      WHERE id = $1 AND kind = 'creator' AND status = 'pending'
      RETURNING id, user_id, amount_cents::text, iban`,
    [args.id, args.note],
  );
  const pr = rows[0];
  if (!pr) return { ok: false, code: "not_pending" };
  const amount = Number(pr.amount_cents);

  if (args.action === "rejected") {
    await creditUser({ userId: pr.user_id, amountCents: amount, refType: "payout_refund", refId: pr.id, description: "creator_payout_rejected" });
    await dbQuery(
      `UPDATE payout_requests SET status = 'rejected', resolved_at = now(), resolved_by = 'admin' WHERE id = $1`,
      [pr.id],
    );
    await notifyLocalized(pr.user_id, "creatorPayoutRejected", { url: "/creator/payouts", values: { amount: amount / 100 } });
    return { ok: true, status: "rejected", via: null };
  }

  const readiness = await getPayoutReadiness(pr.user_id);
  // Transfer bancar manual fără IBAN = nimic de plătit: cererea rămâne în așteptare.
  if (!(readiness.method === "stripe" && readiness.accountId) && !pr.iban) {
    await dbQuery(`UPDATE payout_requests SET status = 'pending', failure_reason = 'iban_missing' WHERE id = $1`, [pr.id]);
    return { ok: false, code: "iban_missing" };
  }
  let transferId: string | null = null;
  if (readiness.method === "stripe" && readiness.accountId) {
    try {
      const transfer = await getStripe().transfers.create(
        { amount, currency: "ron", destination: readiness.accountId, metadata: { type: "creator_payout", payout_id: pr.id } },
        { idempotencyKey: `creator_payout:${pr.id}` },
      );
      transferId = transfer.id;
    } catch (err) {
      logger.error({ err, payoutId: pr.id }, "creator.payout.transfer_failed");
      await dbQuery(
        `UPDATE payout_requests SET status = 'pending', failure_reason = $2 WHERE id = $1`,
        [pr.id, String((err as Error)?.message ?? "transfer_failed").slice(0, 300)],
      );
      return { ok: false, code: "transfer_failed" };
    }
  }
  await dbQuery(
    `UPDATE payout_requests
        SET status = 'paid', paid_at = now(), resolved_at = now(), resolved_by = 'admin',
            stripe_transfer_id = $2, failure_reason = NULL
      WHERE id = $1`,
    [pr.id, transferId],
  );
  await notifyLocalized(pr.user_id, "creatorPayoutPaid", { url: "/creator/payouts", values: { amount: amount / 100 } });
  return { ok: true, status: "paid", via: transferId ? "stripe" : "bank" };
}
