import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { createDashboardLoginLink } from "@/lib/stripe/connect";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireAuth(req, ["creator", "seller", "admin"]);
  if (auth instanceof NextResponse) return auth;
  if (!auth.userId) return NextResponse.json({ error: "Cont invalid" }, { status: 400 });

  const rl = await rateLimit("stripeLoginLink", auth.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const { rows } = await dbQuery<{ stripe_connect_account_id: string | null }>(
    `SELECT stripe_connect_account_id FROM users WHERE id = $1 LIMIT 1`,
    [auth.userId],
  );
  const accountId = rows[0]?.stripe_connect_account_id;
  if (!accountId) return NextResponse.json({ error: "Niciun cont Stripe Connect" }, { status: 400 });

  try {
    const url = await createDashboardLoginLink(accountId);
    return NextResponse.json({ url });
  } catch (err: any) {
    logger.error({ err }, "[stripe-connect] login link failed");
    return NextResponse.json({ error: err?.message || "Eroare la generarea link-ului" }, { status: 500 });
  }
}
