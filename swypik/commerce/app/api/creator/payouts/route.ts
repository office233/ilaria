/**
 * Retrageri creator (din portofelul RON).
 *   GET  /api/creator/payouts → { readiness, balanceCents, payouts }
 *   POST /api/creator/payouts { amountCents, iban? } → { id, method }
 *     iban obligatoriu când Stripe Connect nu e disponibil (transfer bancar manual).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCreatorUserIdWithRoleCheck } from "@/lib/creator/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { getPayoutReadiness, getWithdrawable, listCreatorPayouts, requestCreatorPayout } from "@/lib/creator/payouts";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const IBAN_RE = /^[A-Z]{2}[0-9]{2}[0-9A-Z]{11,30}$/;

const BodySchema = z
  .object({
    amountCents: z.number().int().positive().max(100_000_000),
    iban: z
      .string()
      .transform((v) => v.replace(/\s+/g, "").toUpperCase())
      .refine((v) => IBAN_RE.test(v), "invalid_iban")
      .optional()
      .nullable(),
  })
  .strict();

export async function GET() {
  const session = await getCreatorUserIdWithRoleCheck();
  if (!session) return NextResponse.json({ error: "creator_required" }, { status: 403 });
  const [readiness, funds, payouts] = await Promise.all([
    getPayoutReadiness(session.userId),
    getWithdrawable(session.userId),
    listCreatorPayouts(session.userId),
  ]);
  const { accountId: _accountId, ...publicReadiness } = readiness;
  return NextResponse.json({
    readiness: publicReadiness,
    balanceCents: funds.balanceCents,
    heldCents: funds.heldCents,
    holdDays: funds.holdDays,
    payouts,
  });
}

export async function POST(req: Request) {
  const session = await getCreatorUserIdWithRoleCheck();
  if (!session) return NextResponse.json({ error: "creator_required" }, { status: 403 });

  const rl = await rateLimit("creator-payout", session.userId, { limit: 5, window: 3600 });
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(BodySchema, await req.json().catch(() => null));
  if (!parsed.ok) {
    const ibanIssue = parsed.issues.some((i) => i.path[0] === "iban");
    return NextResponse.json({ error: ibanIssue ? "invalid_iban" : "invalid_body", code: parsed.code }, { status: 400 });
  }

  try {
    const res = await requestCreatorPayout({
      userId: session.userId,
      amountCents: parsed.data.amountCents,
      iban: parsed.data.iban ?? null,
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: res.code, balanceCents: res.balanceCents, withdrawableCents: res.withdrawableCents },
        { status: ["open_request_exists", "insufficient_funds", "funds_on_hold"].includes(res.code) ? 409 : 400 },
      );
    }
    return NextResponse.json({ id: res.id, method: res.method, status: "pending" }, { status: 201 });
  } catch (err) {
    logger.error({ err, userId: session.userId }, "[creator/payouts] request failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
