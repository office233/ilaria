/**
 * Starea de onboarding a unui seller — checklist afișat pe dashboard până e complet.
 * Pașii sunt date (id + link), textele vin din i18n (sellerPanel.onboarding.<id>).
 */
import { dbQuery } from "@/lib/db";
import { stripeConnectAvailable } from "@/lib/creator/payouts";

export const ONBOARDING_STEP_IDS = ["approved", "verified", "profile", "payout", "firstProduct"] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export type OnboardingStep = { id: OnboardingStepId; done: boolean; optional: boolean; href: string | null };
export type SellerOnboarding = { status: string; steps: OnboardingStep[]; requiredDone: number; requiredTotal: number; complete: boolean };

export type OnboardingFacts = {
  status: string;
  isVerified: boolean;
  hasName: boolean;
  hasCui: boolean;
  hasPhone: boolean;
  hasIban: boolean;
  connectReady: boolean;
  productCount: number;
};

/** Pur: faptele → pașii (testabil fără DB). */
export function buildOnboarding(f: OnboardingFacts): SellerOnboarding {
  const steps: OnboardingStep[] = [
    { id: "approved", done: f.status === "approved" || f.status === "active", optional: false, href: null },
    { id: "verified", done: f.isVerified, optional: false, href: null },
    { id: "profile", done: f.hasName && f.hasCui && f.hasPhone, optional: false, href: "/seller/settings" },
    { id: "payout", done: f.hasIban || f.connectReady, optional: false, href: "/seller/payouts" },
    { id: "firstProduct", done: f.productCount > 0, optional: false, href: "/seller/products" },
  ];
  const required = steps.filter((s) => !s.optional);
  const requiredDone = required.filter((s) => s.done).length;
  return { status: f.status, steps, requiredDone, requiredTotal: required.length, complete: requiredDone === required.length };
}

export async function getSellerOnboarding(sellerId: string): Promise<SellerOnboarding | null> {
  const { rows } = await dbQuery<{
    status: string; is_verified: boolean; name: string | null; cui: string | null; phone: string | null;
    iban: string | null; account_id: string | null; payouts_enabled: boolean; products: number;
  }>(
    `SELECT s.status, s.is_verified, s.name, s.cui, s.phone,
            NULLIF(s.business_details->>'iban', '') AS iban,
            COALESCE(s.stripe_account_id, s.metadata->>'stripe_account_id') AS account_id,
            s.stripe_payouts_enabled AS payouts_enabled,
            (SELECT COUNT(*)::int FROM marketplace_products p WHERE p.seller_id = s.id AND p.status <> 'archived') AS products
       FROM sellers s WHERE s.id = $1`,
    [sellerId],
  );
  const r = rows[0];
  if (!r) return null;
  return buildOnboarding({
    status: r.status,
    isVerified: r.is_verified,
    hasName: Boolean(r.name?.trim()),
    hasCui: Boolean(r.cui?.trim()),
    hasPhone: Boolean(r.phone?.trim()),
    hasIban: Boolean(r.iban),
    connectReady: stripeConnectAvailable() && Boolean(r.account_id) && r.payouts_enabled,
    productCount: Number(r.products || 0),
  });
}
