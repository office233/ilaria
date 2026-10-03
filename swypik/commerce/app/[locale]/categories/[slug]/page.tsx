import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { CatalogGrid } from "@/components/shop/catalog/CatalogGrid";
import { CatalogToolbar } from "@/components/shop/catalog/CatalogToolbar";
import { Link } from "@/lib/i18n/navigation";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { languagesForMetadata, localizedUrl } from "@/lib/seo/hreflang";
import { safeJsonLd } from "@/lib/seo/json-ld";
import { APP_URL } from "@/lib/app-url";
import { listCatalog } from "@/lib/shop/catalog";
import { decodeCategorySlug, findCategoryPath, getShopCategories, parseCatalogSort } from "@/lib/shop/categories";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const categoryHref = (id: string) => `/categories/${encodeURIComponent(id)}`;

async function resolve(params: Props["params"]) {
  const { locale: rawLocale, slug: rawSlug } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const slug = decodeCategorySlug(rawSlug);
  const tree = await getShopCategories(locale).catch(() => []);
  return { locale, slug, path: findCategoryPath(tree, slug) };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug, path } = await resolve(params);
  if (!path) return {};
  const current = path[path.length - 1];
  const t = await getTranslations({ locale, namespace: "shopBuyer.categories" });
  const url = localizedUrl(locale, categoryHref(slug));
  const title = t("metaCategoryTitle", { name: current.name });
  const description = t("metaCategoryDescription", { name: current.name });
  return {
    title,
    description,
    alternates: { canonical: url, languages: languagesForMetadata(categoryHref(slug)) },
    openGraph: { title, description, url, type: "website" },
  };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  // Arborele se rezolvă ÎNAINTE de produse: notFound() trebuie să scurtcircuiteze
  // înainte de streaming, altfel Next degradează 404 în 200.
  const { locale, slug, path } = await resolve(params);
  if (!path) notFound();
  const sp = await searchParams;
  const sort = parseCatalogSort(sp.sort);
  const t = await getTranslations({ locale, namespace: "shopBuyer" });
  const current = path[path.length - 1];
  const children = current.children ?? [];
  const page = await listCatalog({ category: slug, sort, locale });

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: t("categories.title"), item: `${APP_URL}/categories` },
        ...path.map((n, i) => ({ "@type": "ListItem", position: i + 2, name: n.name, item: `${APP_URL}${categoryHref(n.id)}` })),
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: page.items.slice(0, 24).map((p, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${APP_URL}/product/${p.id}`,
        name: p.title,
      })),
    },
  ];

  return (
    <div className="min-h-dvh bg-canvas">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }} />
      <PageHeader back="/categories" title={current.name} subtitle={t("categories.productsCount", { count: current.count ?? 0 })} />
      <main className="mx-auto max-w-5xl space-y-4 px-gutter py-4">
        {path.length > 1 ? (
          <nav aria-label={t("categories.breadcrumb")} className="no-scrollbar flex items-center gap-1 overflow-x-auto text-sm text-muted">
            {path.slice(0, -1).map((n) => (
              <span key={n.id} className="flex shrink-0 items-center gap-1">
                <Link href={categoryHref(n.id)} className="inline-flex min-h-[2.75rem] items-center hover:text-fg">
                  {n.name}
                </Link>
                <ChevronRight className="h-4 w-4" aria-hidden />
              </span>
            ))}
            <span className="shrink-0 font-medium text-fg">{current.name}</span>
          </nav>
        ) : null}

        {children.length > 0 ? (
          <section aria-label={t("categories.subcategories")}>
            <ul className="no-scrollbar -mx-gutter flex gap-2 overflow-x-auto px-gutter">
              {children.map((child) => (
                <li key={child.id} className="shrink-0">
                  <Link
                    href={categoryHref(child.id)}
                    className="inline-flex h-11 items-center gap-2 rounded-full border border-subtle bg-surface px-4 text-sm text-fg hover:bg-surface-2"
                  >
                    {child.name}
                    <span className="text-xs text-subtle">{child.count ?? 0}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <CatalogToolbar sort={sort} />
        <CatalogGrid
          initial={page}
          filters={{ category: slug, sort }}
          empty={{
            title: t("categories.emptyCategory"),
            action: (
              <Button asChild variant="secondary">
                <Link href="/shop">{t("categories.browseAll")}</Link>
              </Button>
            ),
          }}
        />
      </main>
    </div>
  );
}
