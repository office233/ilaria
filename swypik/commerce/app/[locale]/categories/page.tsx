import type { Metadata } from "next";
import { ChevronRight, LayoutGrid } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Link } from "@/lib/i18n/navigation";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { languagesForMetadata, localizedUrl } from "@/lib/seo/hreflang";
import { safeJsonLd } from "@/lib/seo/json-ld";
import { APP_URL } from "@/lib/app-url";
import { getShopCategories } from "@/lib/shop/categories";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "shopBuyer.categories" });
  const canonical = localizedUrl(locale, "/categories");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical, languages: languagesForMetadata("/categories") },
    openGraph: { title: t("metaTitle"), description: t("metaDescription"), url: canonical, type: "website" },
  };
}

const categoryHref = (id: string) => `/categories/${encodeURIComponent(id)}`;

export default async function CategoriesPage({ params }: Props) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = await getTranslations({ locale, namespace: "shopBuyer.categories" });
  const tree = await getShopCategories(locale).catch(() => []);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: t("title"),
    url: `${APP_URL}/categories`,
    hasPart: tree.slice(0, 20).map((n) => ({ "@type": "Thing", name: n.name, url: `${APP_URL}${categoryHref(n.id)}` })),
  };

  return (
    <div className="min-h-dvh bg-canvas">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }} />
      <PageHeader title={t("title")} />
      <main className="mx-auto max-w-5xl px-gutter py-4">
        {tree.length === 0 ? (
          <EmptyState
            icon={LayoutGrid}
            title={t("emptyTitle")}
            description={t("emptyBody")}
            action={
              <Button asChild>
                <Link href="/shop">{t("browseAll")}</Link>
              </Button>
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tree.map((dept) => (
              <li key={dept.id}>
                <Card padding="none" className="overflow-hidden">
                  <Link
                    href={categoryHref(dept.id)}
                    className="flex min-h-[3.5rem] items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-base font-semibold text-fg">{dept.name}</span>
                      <span className="text-xs text-muted">{t("productsCount", { count: dept.count ?? 0 })}</span>
                    </span>
                    <ChevronRight className="h-5 w-5 shrink-0 text-subtle" aria-hidden />
                  </Link>
                  {dept.children?.length ? (
                    <ul className="no-scrollbar flex gap-2 overflow-x-auto border-t border-subtle px-4 py-3">
                      {dept.children.slice(0, 12).map((child) => (
                        <li key={child.id} className="shrink-0">
                          <Link
                            href={categoryHref(child.id)}
                            className="inline-flex h-11 items-center rounded-full border border-subtle bg-surface-2 px-4 text-sm text-fg hover:border-strong"
                          >
                            {child.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
