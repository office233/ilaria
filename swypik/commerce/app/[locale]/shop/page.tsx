import type { Metadata } from "next";
import { ShoppingCart } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { CatalogGrid } from "@/components/shop/catalog/CatalogGrid";
import { CatalogToolbar } from "@/components/shop/catalog/CatalogToolbar";
import { Link } from "@/lib/i18n/navigation";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { listCatalog } from "@/lib/shop/catalog";
import { firstParam, getShopCategories, parseCatalogSort } from "@/lib/shop/categories";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "shopBuyer.catalog" });
  return { title: t("metaTitle"), description: t("metaDescription"), alternates: localizedAlternates(locale, "/shop") };
}

export default async function ShopPage({ params, searchParams }: Props) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;
  const t = await getTranslations({ locale, namespace: "shopBuyer" });

  const q = firstParam(sp.q);
  const category = firstParam(sp.category);
  const sort = parseCatalogSort(sp.sort);
  const [page, categories] = await Promise.all([
    listCatalog({ q, category, sort, locale }),
    getShopCategories(locale).catch(() => []),
  ]);
  const filtered = Boolean(q || category);

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader
        title={t("catalog.title")}
        actions={
          <IconButton asChild label={t("common.cart")}>
            <Link href="/cart">
              <ShoppingCart aria-hidden />
            </Link>
          </IconButton>
        }
      />
      <main className="mx-auto max-w-5xl space-y-4 px-gutter py-4">
        <CatalogToolbar
          withSearch
          q={q}
          sort={sort}
          activeCategory={category}
          chips={categories.map((c) => ({ slug: c.id, name: c.name }))}
        />
        {q ? <p className="text-sm text-muted">{t("catalog.resultsFor", { query: q })}</p> : null}
        <CatalogGrid
          initial={page}
          filters={{ q, category, sort }}
          empty={
            filtered
              ? {
                  title: t("catalog.noResultsTitle"),
                  description: q ? t("catalog.noResultsBody", { query: q }) : undefined,
                  action: (
                    <Button asChild variant="secondary">
                      <Link href="/shop">{t("catalog.clearFilters")}</Link>
                    </Button>
                  ),
                }
              : { title: t("catalog.emptyTitle"), description: t("catalog.emptyBody") }
          }
        />
      </main>
    </div>
  );
}
