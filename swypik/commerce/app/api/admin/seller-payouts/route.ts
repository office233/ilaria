/**
 * Admin — cererile de retragere ale seller-ilor (payout_requests, kind = 'seller').
 *   GET  /api/admin/seller-payouts?status=pending
 *   POST /api/admin/seller-payouts { id, action: 'paid' | 'rejected', note? }
 *     paid → transfer Stripe Connect dacă e disponibil pentru seller, altfel confirmă
 *            transferul bancar manual (IBAN); rejected → item-urile revin în soldul seller-ului.
 * Forma rândurilor e aceeași ca la /api/admin/creator-payouts (UI comun).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { parseBody } from "@/lib/validation/schemas";
import { stripeConnectAvailable } from "@/lib/creator/payouts";
import { resolveSellerPayout } from "@/lib/seller/payouts";
import { logAdminAction } from "@/lib/security/admin-audit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set(["pending", "processing", "paid", "rejected", "failed"]);

const PostSchema = z
  .object({ id: z.string().uuid(), action: z.enum(["paid", "rejected"]), note: z.string().max(500).optional().nullable() })
  .strict();

export async function GET(req: Request) {
  const auth = await requireAdmin(req, "finance");
  if (auth instanceof NextResponse) return auth;
  const status = new URL(req.url).searchParams.get("status");
  if (status && !STATUSES.has(status)) return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  const { rows } = await dbQuery(
    `SELECT pr.id, pr.seller_id AS user_id, pr.amount_cents::int8 AS amount_cents, pr.status, pr.iban,
            pr.admin_note, pr.failure_reason, pr.requested_at, pr.resolved_at, pr.stripe_transfer_id,
            NULL::text AS username, s.name AS display_name, s.email,
            s.stripe_payouts_enabled AS connect_ready,
            pr.amount_cents::int8 AS balance_cents
       FROM payout_requests pr
       JOIN sellers s ON s.id = pr.seller_id
      WHERE pr.kind = 'seller' AND ($1::text IS NULL OR pr.status = $1::text)
      ORDER BY pr.requested_at DESC
      LIMIT 200`,
    [status],
  );
  return NextResponse.json({ payouts: rows, connectAvailable: stripeConnectAvailable() });
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req, "finance");
  if (auth instanceof NextResponse) return auth;
  const parsed = parseBody(PostSchema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: "invalid_body", code: parsed.code }, { status: 400 });

  try {
    const res = await resolveSellerPayout({ id: parsed.data.id, action: parsed.data.action, note: parsed.data.note ?? null });
    if (!res.ok) {
      const status = res.code === "transfer_failed" ? 502 : 409;
      return NextResponse.json({ error: res.code }, { status });
    }
    await logAdminAction({
      action: `seller_payout.${res.status}`,
      targetType: "payout_request",
      targetId: parsed.data.id,
      details: { via: res.via, amountCents: res.amountCents, note: parsed.data.note ?? null },
      actor: auth,
      req,
    });
    return NextResponse.json(res);
  } catch (err) {
    logger.error({ err, id: parsed.data.id }, "[admin/seller-payouts] resolve failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
