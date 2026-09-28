/**
 * CANONICAL Stripe Connect data: stored on USERS.stripe_connect_* columns.
 * The legacy table creator_connect_accounts is currently empty (0 rows in prod 2026-05-15)
 * and is NOT written/read by application code. Treat it as deprecated; if reactivated,
 * migrate user-level columns into it as the canonical source and remove from users.
 */
import { getStripe } from "./checkout";
import { dbQuery } from "@/lib/db";
import type Stripe from "stripe";
import { APP_URL } from "@/lib/app-url";

const ORIGIN = process.env.NEXT_PUBLIC_SITE_URL || APP_URL;

export type ConnectStatus = {
  accountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  onboardedAt: string | null;
  requirementsCurrentlyDue: string[];
  requirementsPastDue: string[];
  requirementsDisabledReason: string | null;
};

export async function getOrCreateConnectAccount(userId: string, email: string | null): Promise<string> {
  const { rows } = await dbQuery<{ stripe_connect_account_id: string | null }>(
    `SELECT stripe_connect_account_id FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const existing = rows[0]?.stripe_connect_account_id;
  if (existing) return existing;

  const stripe = getStripe();
  const account = await stripe.accounts.create({
    type: "express",
    country: "RO",
    email: email || undefined,
    capabilities: {
      transfers: { requested: true },
    },
    business_type: "individual",
    metadata: { userId },
  });

  await dbQuery(
    `UPDATE users SET stripe_connect_account_id = $1, updated_at = now() WHERE id = $2`,
    [account.id, userId],
  );
  return account.id;
}

export async function createOnboardingLink(accountId: string): Promise<string> {
  const stripe = getStripe();
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${ORIGIN}/creator/payouts?refresh=1`,
    return_url: `${ORIGIN}/creator/payouts?success=1`,
    type: "account_onboarding",
  });
  return link.url;
}

export async function createDashboardLoginLink(accountId: string): Promise<string> {
  const stripe = getStripe();
  const link = await stripe.accounts.createLoginLink(accountId);
  return link.url;
}

export async function syncConnectAccount(accountId: string): Promise<ConnectStatus> {
  const stripe = getStripe();
  const acc = await stripe.accounts.retrieve(accountId);
  return persistConnectAccount(acc);
}

export async function persistConnectAccount(acc: Stripe.Account): Promise<ConnectStatus> {
  const chargesEnabled = !!acc.charges_enabled;
  const payoutsEnabled = !!acc.payouts_enabled;
  const detailsSubmitted = !!acc.details_submitted;
  const requirements = {
    currently_due: acc.requirements?.currently_due || [],
    past_due: acc.requirements?.past_due || [],
    disabled_reason: acc.requirements?.disabled_reason || null,
  };

  // The same Stripe account may belong to either a creator (users table) or a
  // seller (sellers table). We attempt both updates so account.updated webhook
  // works regardless of which onboarding flow created the account.
  await dbQuery(
    `UPDATE users SET
       stripe_connect_charges_enabled = $1,
       stripe_connect_payouts_enabled = $2,
       stripe_connect_details_submitted = $3,
       stripe_connect_onboarded_at = CASE WHEN $3 AND stripe_connect_onboarded_at IS NULL THEN now() ELSE stripe_connect_onboarded_at END,
       updated_at = now()
     WHERE stripe_connect_account_id = $4`,
    [chargesEnabled, payoutsEnabled, detailsSubmitted, acc.id],
  );

  await dbQuery(
    `UPDATE sellers SET
       stripe_charges_enabled = $1,
       stripe_payouts_enabled = $2,
       stripe_details_submitted = $3,
       stripe_onboarded_at = CASE WHEN $3 AND stripe_onboarded_at IS NULL THEN now() ELSE stripe_onboarded_at END,
       stripe_requirements = $5::jsonb,
       updated_at = now()
     WHERE stripe_account_id = $4`,
    [chargesEnabled, payoutsEnabled, detailsSubmitted, acc.id, JSON.stringify(requirements)],
  );

  return {
    accountId: acc.id,
    chargesEnabled,
    payoutsEnabled,
    detailsSubmitted,
    onboardedAt: detailsSubmitted ? new Date().toISOString() : null,
    requirementsCurrentlyDue: requirements.currently_due,
    requirementsPastDue: requirements.past_due,
    requirementsDisabledReason: requirements.disabled_reason,
  };
}
