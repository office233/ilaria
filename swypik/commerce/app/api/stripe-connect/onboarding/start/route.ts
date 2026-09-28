import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { getOrCreateConnectAccount, createOnboardingLink } from "@/lib/stripe/connect";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (process.env.FEATURE_STRIPE_CONNECT !== "1") {
    return NextResponse.json({ error: "Stripe Connect dezactivat" }, { status: 503 });
  }
  const auth = await requireAuth(req, ["creator", "seller", "admin"]);
  if (auth instanceof NextResponse) return auth;
  if (!auth.userId) return NextResponse.json({ error: "Cont invalid" }, { status: 400 });

  const rl = await rateLimit("stripeOnboarding", auth.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  try {
    const { rows } = await dbQuery<{ email: string | null }>(
      `SELECT email FROM users WHERE id = $1 LIMIT 1`,
      [auth.userId],
    );
    const email = rows[0]?.email ?? auth.email ?? null;
    const accountId = await getOrCreateConnectAccount(auth.userId, email);
    const url = await createOnboardingLink(accountId);
    return NextResponse.json({ url, accountId });
  } catch (err: any) {
    logger.error({ err }, "[stripe-connect] onboarding start failed");
    return NextResponse.json({ error: err?.message || "Eroare la pornirea onboarding-ului" }, { status: 500 });
  }
}
