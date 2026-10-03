import { NextResponse } from "next/server";
import { frozenResponse, isEnabled } from "@/lib/feature-flags";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { getStripe } from "@/lib/stripe/checkout";
import { persistConnectAccount } from "@/lib/stripe/connect";
import { rateLimit } from "@/lib/security/rate-limit";

import { logger } from "@/lib/logger";
import { APP_URL } from "@/lib/app-url";
export const dynamic = "force-dynamic";

const RETURN_PATH = "/seller/payouts?stripe=connected";
const REFRESH_PATH = "/seller/payouts?stripe=refresh";

function appUrl() {
  return process.env.NEXT_PUBLIC_APP_URL
    || process.env.NEXT_PUBLIC_SITE_URL
    || APP_URL;
}

export async function POST() {
  if (!isEnabled("stripeConnect")) return frozenResponse("stripeConnect");
  try {
    const sellerId = await getSellerSessionId();
    if (!sellerId) {
      return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("stripeConnect", sellerId);
    if (!rl.success) return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });

    const sellerRes = await dbQuery<{ email: string; name: string | null; stripe_account_id: string | null; metadata: any }>(
      `SELECT email, name, stripe_account_id, metadata FROM sellers WHERE id = $1`,
      [sellerId],
    );

    if (sellerRes.rows.length === 0) {
      return NextResponse.json({ success: false, error: "seller_not_found" }, { status: 404 });
    }

    const seller = sellerRes.rows[0];
    const sellerMetadata = seller.metadata || {};
    const stripe = getStripe();
    let stripeAccountId = seller.stripe_account_id || sellerMetadata.stripe_account_id;

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        // 2026-08-10 (audit P1): țara + tipul de business din config, cu
        // fallback RO/company. Permite onboarding Stripe Connect în alte țări
        // fără schimbare de cod (STRIPE_CONNECT_COUNTRY / STRIPE_CONNECT_BUSINESS_TYPE).
        country: process.env.STRIPE_CONNECT_COUNTRY || "RO",
        email: seller.email,
        capabilities: {
          transfers: { requested: true },
        },
        business_type:
          (process.env.STRIPE_CONNECT_BUSINESS_TYPE as "company" | "individual") || "company",
        metadata: {
          seller_id: sellerId,
          seller_name: seller.name || "",
        },
      });
      stripeAccountId = account.id;

      await dbQuery(
        `UPDATE sellers
         SET stripe_account_id = $1,
             metadata = metadata || $2::jsonb,
             updated_at = now()
         WHERE id = $3`,
        [stripeAccountId, JSON.stringify({ stripe_account_id: stripeAccountId }), sellerId],
      );
    }

    const base = appUrl();
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${base}${REFRESH_PATH}`,
      return_url: `${base}${RETURN_PATH}`,
      type: "account_onboarding",
    });

    return NextResponse.json({ success: true, url: accountLink.url });
  } catch (error) {
    logger.error({ err: error }, "[Stripe Connect API] POST Error:");
    return NextResponse.json({ success: false, error: "stripe_connect_failed" }, { status: 500 });
  }
}

export async function GET() {
  if (!isEnabled("stripeConnect")) return frozenResponse("stripeConnect");
  try {
    const sellerId = await getSellerSessionId();
    if (!sellerId) {
      return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
    }

    const { rows } = await dbQuery<{
      stripe_account_id: string | null;
      stripe_charges_enabled: boolean;
      stripe_payouts_enabled: boolean;
      stripe_details_submitted: boolean;
      stripe_onboarded_at: Date | null;
      stripe_requirements: any;
    }>(
      `SELECT stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled,
              stripe_details_submitted, stripe_onboarded_at, stripe_requirements
       FROM sellers WHERE id = $1 LIMIT 1`,
      [sellerId],
    );

    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: "seller_not_found" }, { status: 404 });
    }

    const row = rows[0];
    const accountId = row.stripe_account_id;

    let status = {
      accountId,
      chargesEnabled: row.stripe_charges_enabled,
      payoutsEnabled: row.stripe_payouts_enabled,
      detailsSubmitted: row.stripe_details_submitted,
      onboardedAt: row.stripe_onboarded_at ? row.stripe_onboarded_at.toISOString() : null,
      requirementsCurrentlyDue: row.stripe_requirements?.currently_due || [],
      requirementsPastDue: row.stripe_requirements?.past_due || [],
      requirementsDisabledReason: row.stripe_requirements?.disabled_reason || null,
    };

    // Refresh from Stripe if account exists but payouts not yet enabled, in case
    // we missed the account.updated webhook.
    if (accountId && !row.stripe_payouts_enabled) {
      try {
        const stripe = getStripe();
        const acc = await stripe.accounts.retrieve(accountId);
        status = await persistConnectAccount(acc);
      } catch (e) {
        logger.warn({ err: e, accountId }, "[Stripe Connect API] GET refresh failed");
      }
    }

    return NextResponse.json({ success: true, status });
  } catch (error) {
    logger.error({ err: error }, "[Stripe Connect API] GET Error:");
    return NextResponse.json({ success: false, error: "stripe_status_failed" }, { status: 500 });
  }
}
