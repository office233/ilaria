/**
 * GET  /api/seller/payouts  → sold (disponibil / în fereastra de retur / cerut / plătit),
 *                             metoda de plată (Stripe Connect sau IBAN), istoricul cererilor.
 * POST /api/seller/payouts { iban? } → cere retragerea întregului sold disponibil
 *                             (payout_requests kind='seller', aprobat în /admin/seller-payouts).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { getSellerBalance, getSellerPayoutSetup, listSellerPayoutRequests, maskIban, requestSellerPayout } from "@/lib/seller/payouts";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** IBAN: 15–34 caractere, țară + cifre de control + alfanumeric (spațiile se elimină). */
const IbanSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, "").toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/));

const PostSchema = z.object({ iban: IbanSchema.optional().nullable() }).strict();

const STATUS_BY_CODE: Record<string, number> = { below_minimum: 422, iban_required: 422, open_request_exists: 409 };

export async function GET() {
  const sellerId = await getSellerSessionId();
  if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  try {
    const [setup, balance, requests] = await Promise.all([
      getSellerPayoutSetup(sellerId),
      getSellerBalance(sellerId),
      listSellerPayoutRequests(sellerId),
    ]);
    const { accountId: _accountId, iban, ...publicSetup } = setup;
    return NextResponse.json({
      success: true,
      setup: { ...publicSetup, ibanMasked: maskIban(iban), hasIban: Boolean(iban) },
      balance,
      requests,
    });
  } catch (err) {
    logger.error({ err }, "[seller/payouts] GET failed");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const sellerId = await getSellerSessionId();
  if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });

  const rl = await rateLimit("sellerPayout", sellerId);
  if (!rl.success) return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(PostSchema, await req.json().catch(() => ({})));
  if (!parsed.ok) return NextResponse.json({ success: false, error: "invalid_iban" }, { status: 400 });

  try {
    const res = await requestSellerPayout({ sellerId, iban: parsed.data.iban ?? null });
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: res.code, availableCents: res.availableCents ?? null },
        { status: STATUS_BY_CODE[res.code] ?? 400 },
      );
    }
    return NextResponse.json({ success: true, id: res.id, amountCents: res.amountCents, method: res.method });
  } catch (err) {
    // Index unic (o cerere deschisă per seller) — cerere concurentă.
    if ((err as { code?: string })?.code === "23505") {
      return NextResponse.json({ success: false, error: "open_request_exists" }, { status: 409 });
    }
    logger.error({ err, sellerId }, "[seller/payouts] POST failed");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
