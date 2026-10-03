/**
 * FRONT R5 — Admin: aprobare/respingere cereri de payout curieri.
 *
 * GET  /api/admin/courier-payouts?status=pending — listă
 * POST /api/admin/courier-payouts { id, action: 'paid'|'rejected', note? }
 *   'paid'     → marchează plătită (transferul bancar se face manual deocamdată)
 *   'rejected' → recreditează suma în wallet (ref 'payout_refund:{id}')
 *
 * Client-facing `error` values are stable codes (never Romanian sentences) —
 * the admin UI (courier-payouts/page.tsx) translates them for display.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery, withTransaction } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { creditUserTx } from "@/lib/wallet/ledger";
import { logAdminAction } from "@/lib/security/admin-audit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger.child({ route: "admin/courier-payouts" });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PostSchema = z.object({
  id: z.string().regex(UUID_RE),
  action: z.enum(["paid", "rejected"]),
  note: z.string().max(500).optional().nullable(),
});

type PayoutRow = {
  id: string;
  user_id: string;
  amount_cents: string;
  status: string;
};

export async function GET(req: Request) {
  const actor = await requireAdmin(req, "finance");
  if (actor instanceof NextResponse) return actor;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const params: unknown[] = [];
  // Doar cererile curierilor; cele ale creatorilor au coada lor (/api/admin/creator-payouts).
  let where = "WHERE pr.kind = 'courier'";
  if (status && ["pending", "paid", "rejected"].includes(status)) {
    params.push(status);
    where += " AND pr.status = $1";
  }
  try {
    const { rows } = await dbQuery(
      `SELECT pr.id, pr.user_id, pr.amount_cents::int8 AS amount_cents, pr.currency,
              pr.status, pr.iban, pr.admin_note, pr.requested_at, pr.resolved_at,
              u.email, u.display_name,
              COALESCE(wb.balance_cents, 0)::int8 AS balance_cents
         FROM payout_requests pr
         JOIN users u ON u.id = pr.user_id
         LEFT JOIN wallet_balances wb ON wb.user_id = pr.user_id
         ${where}
        ORDER BY pr.requested_at DESC
        LIMIT 200`,
      params,
    );
    return NextResponse.json({ payouts: rows });
  } catch (err) {
    log.error({ err }, "failed to list courier payouts");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const actor = await requireAdmin(req, "finance");
  if (actor instanceof NextResponse) return actor;
  const parsed = PostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { id, action, note } = parsed.data;

  try {
    // Atomic: lock pe cerere (FOR UPDATE), schimbarea statusului și — la respingere —
    // recreditarea în wallet în ACEEAȘI tranzacție. Înainte, o eroare la credit lăsa
    // cererea „rejected” fără banii înapoi.
    const pr = await withTransaction<PayoutRow | null>(async (q) => {
      const { rows: locked } = await q<PayoutRow>(
        `SELECT id, user_id, amount_cents::text AS amount_cents, status
           FROM payout_requests
          WHERE id = $1 AND kind = 'courier'
          FOR UPDATE`,
        [id],
      );
      if (!locked[0] || locked[0].status !== "pending") return null;
      await q(
        `UPDATE payout_requests
            SET status = $2, admin_note = $3, resolved_at = now(), resolved_by = 'admin'
          WHERE id = $1`,
        [id, action, note ?? null],
      );
      if (action === "rejected") {
        // Banii debitați la cerere se întorc în wallet (idempotent pe ref).
        await creditUserTx(q, {
          userId: locked[0].user_id,
          amountCents: Number(locked[0].amount_cents),
          refType: "payout_refund",
          refId: locked[0].id,
          description: "Retragere respinsă — sumă returnată în sold",
        });
      }
      return locked[0];
    });
    if (!pr) {
      return NextResponse.json({ error: "payout_not_pending" }, { status: 409 });
    }

    await logAdminAction({
      action: action === "paid" ? "courier_payout.mark_paid" : "courier_payout.reject",
      targetType: "payout_request",
      targetId: pr.id,
      details: { note: note ?? null },
      req,
      actor,
    });

    log.info({ payoutId: pr.id, action }, "courier payout resolved");
    return NextResponse.json({ success: true, id: pr.id, status: action });
  } catch (err) {
    log.error({ err, id, action }, "failed to resolve courier payout");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
