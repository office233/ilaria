import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { syncConnectAccount } from "@/lib/stripe/connect";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAuth(req, ["creator", "seller", "admin"]);
  if (auth instanceof NextResponse) return auth;
  if (!auth.userId) return NextResponse.json({ error: "Cont invalid" }, { status: 400 });

  const { rows } = await dbQuery<{
    stripe_connect_account_id: string | null;
    stripe_connect_charges_enabled: boolean | null;
    stripe_connect_payouts_enabled: boolean | null;
    stripe_connect_details_submitted: boolean | null;
    stripe_connect_onboarded_at: string | null;
  }>(
    `SELECT stripe_connect_account_id, stripe_connect_charges_enabled,
            stripe_connect_payouts_enabled, stripe_connect_details_submitted,
            stripe_connect_onboarded_at
       FROM users WHERE id = $1 LIMIT 1`,
    [auth.userId],
  );
  const u = rows[0];
  if (!u?.stripe_connect_account_id) {
    return NextResponse.json({
      accountId: null,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      onboardedAt: null,
      requirementsCurrentlyDue: [],
      requirementsPastDue: [],
      requirementsDisabledReason: null,
    });
  }

  try {
    const status = await syncConnectAccount(u.stripe_connect_account_id);
    return NextResponse.json(status);
  } catch (err: any) {
    logger.error({ err }, "[stripe-connect] status sync failed");
    return NextResponse.json({
      accountId: u.stripe_connect_account_id,
      chargesEnabled: !!u.stripe_connect_charges_enabled,
      payoutsEnabled: !!u.stripe_connect_payouts_enabled,
      detailsSubmitted: !!u.stripe_connect_details_submitted,
      onboardedAt: u.stripe_connect_onboarded_at,
      requirementsCurrentlyDue: [],
      requirementsPastDue: [],
      requirementsDisabledReason: null,
      syncError: true,
    });
  }
}
