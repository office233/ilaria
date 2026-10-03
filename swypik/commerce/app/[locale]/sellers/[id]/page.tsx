/**
 * Public Seller Storefront — Server Component
 *
 * NOTE: This route lives under app/seller/[id]/ to match the brief, which
 * means it inherits the seller dashboard layout (app/seller/layout.tsx).
 * If the storefront needs a different chrome (no dashboard sidebar), this
 * page should be moved into a route group such as app/(public)/sellers/[id]
 * — flagged here for a follow-up.
 */
import type { Metadata } from "next";
import { Link } from "@/lib/i18n/navigation";
import { Clapperboard, Package, Star, Store } from "lucide-react";
import VerifiedBadge from "@/components/VerifiedBadge";
import { MessageButton } from "@/components/messenger/MessageButton";
import { getProductRatingMap } from "@/lib/reviews/aggregate";
import { notFound } from "next/navigation";
import { dbQuery } from "@/lib/db";
import { getLocale, getTranslations } from "next-intl/server";
import { formatMoneyCents } from "@/lib/i18n/currency";
import { localizedAlternates } from "@/lib/seo/hreflang";

type Props = { params: Promise<{ id: string; locale: string }> };

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Seller = {
  id: string;
  name: string | null;
  status: string;
  created_at: string;
  is_verified: boolean | null;
  user_id: string | null;
  business_details: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

type SellerVideo = {
  id: string;
  slug: string | null;
  title: string;
  thumbnail_url: string | null;
};

type SellerProduct = {
  id: string;
  slug: string | null;
  title: string;
  image_url: string | null;
  price_cents: number | null;
  currency: string;
};

async function getSeller(id: string): Promise<Seller | null> {
  if (!UUID_RE.test(id)) return null;
  const result = await dbQuery<Seller>(
    `SELECT id, name, status, created_at, is_verified, user_id, business_details, metadata
       FROM sellers
      WHERE id = $1
        AND status IN ('approved', 'active')
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function getSellerProducts(id: string): Promise<SellerProduct[]> {
  const result = await dbQuery<SellerProduct>(
    `SELECT id, slug, title, image_url, price_cents, currency
       FROM marketplace_products
      WHERE seller_id = $1
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 24`,
    [id],
  );
  return result.rows;
}

async function getSellerVideos(userId: string | null): Promise<SellerVideo[]> {
  if (!userId) return [];
  const result = await dbQuery<SellerVideo>(
    `SELECT id, slug, title, thumbnail_url
       FROM videos
      WHERE creator_id = $1
        AND status = 'ready' AND visibility = 'public'
        AND COALESCE(is_hidden, false) = false
      ORDER BY created_at DESC
      LIMIT 12`,
    [userId],
  );
  return result.rows;
}

async function getSellerStats(id: string): Promise<{ totalProducts: number }> {
  const result = await dbQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM marketplace_products
      WHERE seller_id = $1 AND status = 'active'`,
    [id],
  );
  return { totalProducts: Number(result.rows[0]?.count ?? 0) };
}

function getDisplayName(seller: Seller): string {
  const bd = seller.business_details ?? {};
  const md = seller.metadata ?? {};
  return (
    (bd as Record<string, unknown>)["company_name"] as string ||
    (bd as Record<string, unknown>)["display_name"] as string ||
    (md as Record<string, unknown>)["display_name"] as string ||
    seller.name ||
    "Vânzător Swypik"
  );
}

function getLogo(seller: Seller): string | null {
  const bd = seller.business_details ?? {};
  const md = seller.metadata ?? {};
  return (
    ((bd as Record<string, unknown>)["logo_url"] as string) ||
    ((md as Record<string, unknown>)["logo_url"] as string) ||
    null
  );
}

function formatPrice(cents: number | null, currency: string): string {
  if (cents == null) return "—";
  return formatMoneyCents(cents, currency);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id, locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  const seller = await getSeller(id);
  if (!seller) return { title: t("sellerNotFound") };
  const name = getDisplayName(seller);
  return {
    alternates: localizedAlternates(locale, `/sellers/${id}`),
    title: t("sellerTitle", { name }),
    description: t("sellerDescription", { name }),
  };
}

export default async function SellerStorefrontPage({ params }: Props) {
  const t = await getTranslations("sellers");
  const { id } = await params;
  const seller = await getSeller(id);
  if (!seller) notFound();

  const [products, stats, videos] = await Promise.all([
    getSellerProducts(seller.id),
    getSellerStats(seller.id),
    getSellerVideos(seller.user_id),
  ]);
  const ratingMap = products.length > 0
    ? await getProductRatingMap(products.map((p) => p.id))
    : new Map();

  const displayName = getDisplayName(seller);
  const logoUrl = getLogo(seller);
  const isVerified = seller.status === "active";
  const memberSince = new Date(seller.created_at).toLocaleDateString(await getLocale(), {
    year: "numeric",
    month: "long",
  });

  return (
    <div className="min-h-screen bg-white text-[#0D0D0D]">
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-10">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:gap-6">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-[#F7F7F8] md:h-24 md:w-24">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt={displayName}
                className="h-full w-full object-cover"
              />
            ) : (
              <Store size={28} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-black tracking-tight md:text-3xl">
                {displayName}
              </h1>
              {seller.is_verified && <VerifiedBadge size={22} />}
              {isVerified && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[#10A37F]/10 px-2.5 py-1 text-xs font-bold text-[#10A37F]">

                  {t("vanzatorVerificat")}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-[#6E6E80]">
              {t("memberSince", { date: memberSince })}
            </p>
          </div>
          {/* Id-ul vânzătorului (nu user id-ul) — serverul rezolvă contul din spate. */}
          {seller.user_id ? (
            <MessageButton entry={{ kind: "seller", id: seller.id }} labelKey="messageSeller" variant="primary" />
          ) : null}
        </header>

        {/* Stats */}
        <section className="mb-8 grid grid-cols-3 gap-3 md:gap-4">
          <div className="rounded-xl border border-[#E5E5E5] bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#6E6E80]">
              {t("productsHeading")}
            </p>
            <p className="mt-1 text-xl font-black md:text-2xl">
              {stats.totalProducts}
            </p>
          </div>
          <div className="rounded-xl border border-[#E5E5E5] bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#6E6E80]">

              {t("vanzari")}
            </p>
            <p className="mt-1 text-xl font-black md:text-2xl">—</p>
          </div>
          <div className="rounded-xl border border-[#E5E5E5] bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#6E6E80]">
              {t("status")}
            </p>
            <p className="mt-1 text-xl font-black md:text-2xl">
              {isVerified ? t("statusActive") : t("statusApproved")}
            </p>
          </div>
        </section>

        {/* Products */}
        <section>
          {videos.length > 0 && (
            <div className="mb-8">
              <h2 className="mb-4 text-lg font-black md:text-xl">{t("clips")}</h2>
              <div className="grid grid-cols-3 gap-3 md:grid-cols-4 lg:grid-cols-6">
                {videos.map((v) => (
                  <Link
                    key={v.id}
                    href={`/video/${v.slug || v.id}`}
                    className="group relative block aspect-[9/16] overflow-hidden rounded-xl border border-[#E5E5E5] bg-[#F7F7F8]"
                  >
                    {v.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={v.thumbnail_url}
                        alt={v.title}
                        className="h-full w-full object-cover transition group-hover:scale-105"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[#C4C4C4]"><Clapperboard size={24} /></div>
                    )}
                    <p className="absolute inset-x-0 bottom-0 line-clamp-2 bg-gradient-to-t from-black/70 to-transparent p-2 text-[11px] font-bold text-white">
                      {v.title}
                    </p>
                  </Link>
                ))}
              </div>
            </div>
          )}
          <h2 className="mb-4 text-lg font-black md:text-xl">{t("productsHeading")}</h2>
          {products.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[#E5E5E5] bg-[#F7F7F8] p-10 text-center">
              <p className="text-sm text-[#6E6E80]">

                {t("produseleAcestuiVanzatorVor")}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-4">
              {products.map((p) => {
                const agg = ratingMap.get(p.id);
                return (
                  <Link
                    key={p.id}
                    href={`/product/${p.id}`}
                    className="group block overflow-hidden rounded-xl border border-[#E5E5E5] bg-white transition hover:border-[#0D0D0D]"
                  >
                    <div className="relative aspect-square overflow-hidden bg-[#F7F7F8]">
                      {p.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.image_url}
                          alt={p.title}
                          className="h-full w-full object-cover transition group-hover:scale-105"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[#C4C4C4]">
                          <Package size={28} />
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <p className="line-clamp-2 text-sm font-semibold leading-snug">
                        {p.title}
                      </p>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <p className="text-sm font-black text-[#10A37F]">
                          {formatPrice(p.price_cents, p.currency)}
                        </p>
                        {agg && agg.reviewCount > 0 && (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6E6E80]"
                            aria-label={t("ratingAria", { rating: agg.avgRating.toFixed(1), count: agg.reviewCount })}
                          >
                            <Star size={11} className="text-[#F59E0B]" fill="currentColor" />
                            {agg.avgRating.toFixed(1)}
                            <span className="text-[#A1A1AA]">({agg.reviewCount})</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
