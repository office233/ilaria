/**
 * Pagina de produs (server): date SSR, SEO (metadata + JSON-LD), recenzii reale.
 * UI-ul interactiv e în components/shop/product/ProductView.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProductActions } from "@/components/shop/product/ProductActions";
import { MessageButton } from "@/components/messenger/MessageButton";
import { ProductView } from "@/components/shop/product/ProductView";
import { ReviewsSection } from "@/components/shop/reviews/ReviewsSection";
import { getAuthSession } from "@/lib/auth/session";
import { DEFAULT_LOCALE, LOCALES, isLocale } from "@/lib/i18n/config";
import { getProductDetail } from "@/lib/products/get-product-detail";
import { safeJsonLd } from "@/lib/seo/json-ld";
import { APP_URL } from "@/lib/app-url";
import { isUuid } from "@/lib/validation/uuid";
import { REVIEWS_PAGE_SIZE, getShopConfig } from "@/lib/shop/config";
import type { CatalogCard } from "@/lib/shop/catalog";
import { buildProductDescription, buildProductJsonLd, getProductAlternates, getProductClips } from "@/lib/shop/product-page";
import { getReviewEligibility, getReviewSummary, listReviews } from "@/lib/shop/reviews";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const loadDetail = cache((id: string, locale: string) => getProductDetail(id, locale));

async function resolveLocale(params: Props["params"]) {
  const { locale, id } = await params;
  return { id, locale: isLocale(locale) ? locale : DEFAULT_LOCALE };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id, locale } = await resolveLocale(params);
  const t = await getTranslations({ locale, namespace: "shopBuyer.product" });
  const detail = await loadDetail(id, locale);
  if (!detail) return { title: t("notFound") };
  const { product } = detail;
  const title = product.seoTitle || product.title;
  const description = buildProductDescription(detail, t("metaFallbackDescription", { title: product.title }));
  const { canonical, languages } = await getProductAlternates(product.id, locale, LOCALES);
  const images = product.images[0] ? [product.images[0]] : [];
  return {
    title: t("metaTitle", { title }),
    description,
    alternates: { canonical, ...(languages ? { languages } : {}) },
    openGraph: { title, description, images: images.map((url) => ({ url, width: 800, height: 800 })), type: "website", locale },
    twitter: { card: "summary_large_image", title, description, images },
  };
}

export default async function ProductPage({ params, searchParams }: Props) {
  const { id, locale } = await resolveLocale(params);
  const detail = await loadDetail(id, locale);
  if (!detail) notFound();
  const productId = detail.product.id;
  const sp = await searchParams;
  const rawVideo = Array.isArray(sp.v) ? sp.v[0] : sp.v;

  const session = await getAuthSession().catch(() => null);
  const [clips, summary, firstPage, eligibility, t] = await Promise.all([
    getProductClips(productId).catch(() => []),
    getReviewSummary(productId),
    listReviews(productId, { sort: "recent", limit: REVIEWS_PAGE_SIZE, offset: 0 }),
    getReviewEligibility(productId, session?.userId ?? null),
    getTranslations({ locale, namespace: "shopBuyer" }),
  ]);

  const similar: CatalogCard[] = detail.similar
    .filter((s) => isUuid(s.id))
    .map((s) => ({
      id: s.id,
      title: s.title,
      priceCents: Math.round(s.price * 100),
      compareAtCents: s.oldPrice ? Math.round(s.oldPrice * 100) : null,
      currency: detail.product.currency,
      image: s.image || null,
      hasVideo: s.hasVideo,
      rating: s.ratingAvg,
      ratingCount: s.ratingCount,
    }));

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: t("catalog.title"), item: `${APP_URL}/shop` },
      { "@type": "ListItem", position: 2, name: detail.product.title.slice(0, 80), item: `${APP_URL}/product/${productId}` },
    ],
  };

  return (
    <div className="min-h-dvh bg-canvas">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd([buildProductJsonLd(detail, summary, locale), breadcrumb]) }}
      />
      <PageHeader back title={detail.product.title} actions={
          <>
            {detail.product.seller ? (
              <MessageButton appearance="icon" entry={{ kind: "seller", id: detail.product.seller.id }} labelKey="messageSeller" />
            ) : null}
            <ProductActions productId={productId} title={detail.product.title} />
          </>
        } />
      <ProductView
        detail={detail}
        clips={clips}
        similar={similar}
        reviewSummary={summary}
        sourceVideoId={isUuid(rawVideo) ? rawVideo : null}
        maxLineQty={getShopConfig().maxLineQty}
        reviews={
          <ReviewsSection
            productId={productId}
            productTitle={detail.product.title}
            summary={summary}
            initialItems={firstPage.items}
            initialHasMore={firstPage.hasMore}
            eligibility={eligibility}
            pageSize={REVIEWS_PAGE_SIZE}
          />
        }
      />
    </div>
  );
}
