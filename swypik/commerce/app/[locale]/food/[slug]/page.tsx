import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { toMerchantSummary, type MerchantRow } from "@/lib/food/merchant-view";
import { DEFAULT_LOCALE } from "@/lib/i18n/config";
import MenuClient from "./MenuClient";
import { localizedAlternates } from "@/lib/seo/hreflang";
import { stripeConfigured } from "@/lib/payments/mobility-stripe";

export const dynamic = "force-dynamic";

async function getMerchant(slug: string): Promise<(MerchantRow & { status: string }) | null> {
  const { rows } = await dbQuery<MerchantRow & { status: string }>(
    `SELECT m.id, m.kind, m.name, m.slug, m.description, m.cuisine_types, m.address,
            m.location_city, m.delivery_fee_cents, m.min_order_cents, m.avg_prep_minutes,
            m.opening_hours, m.is_open_override, m.image_url, m.status, m.listing_mode,
            m.suggestion_count, (m.seller_id IS NOT NULL) AS is_claimed,
            (SELECT count(1)::int FROM menu_items mi WHERE mi.merchant_id = m.id AND mi.is_available) AS menu_count
       FROM local_merchants m WHERE m.slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}): Promise<Metadata> {
  const { slug, locale } = await params;
  const t = await getTranslations({ locale, namespace: "food" });
  const m = await getMerchant(slug);
  if (!m) return { title: "Swypik Food" };
  const orderable = m.listing_mode === "orderable";
  return {
    alternates: localizedAlternates(locale, `/food/${slug}`),
    title: orderable ? `${m.name} — ${t("meta.orderOnline")} | Swypik Food` : `${m.name} | Swypik Food`,
    description: m.description ?? t("meta.merchantDescription", { name: m.name }),
    // Profilurile nerevendicate nu sunt pagini de comandă — nu le indexăm.
    robots: orderable ? undefined : { index: false, follow: true },
  };
}

export default async function MerchantMenuPage({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}) {
  const { slug, locale } = await params;
  const merchant = await getMerchant(slug);
  if (!merchant || merchant.status !== "active") notFound();
  const session = await getAuthSession().catch(() => null);
  const returnPath = `${locale && locale !== DEFAULT_LOCALE ? `/${locale}` : ""}/food/${slug}`;

  return (
    <MenuClient
      merchant={toMerchantSummary(merchant)}
      signedIn={!!session?.userId}
      returnPath={returnPath}
      cardAvailable={stripeConfigured()}
    />
  );
}
