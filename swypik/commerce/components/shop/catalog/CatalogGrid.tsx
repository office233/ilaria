"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { PackageSearch } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import type { CatalogCard, CatalogPage } from "@/lib/shop/catalog";
import type { CatalogSort } from "@/lib/shop/schemas";
import { ProductCard } from "../ProductCard";

export type CatalogFilters = { q?: string; category?: string; sort: CatalogSort };

type Props = {
  initial: CatalogPage;
  filters: CatalogFilters;
  empty: { title: string; description?: string; action?: ReactNode };
};

function buildUrl(filters: CatalogFilters, cursor: string, locale: string): string {
  const sp = new URLSearchParams({ sort: filters.sort, cursor, locale });
  if (filters.q) sp.set("q", filters.q);
  if (filters.category) sp.set("category", filters.category);
  return `/api/shop/products?${sp.toString()}`;
}

export function CatalogGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <li key={i} className="space-y-2">
          <Skeleton className="aspect-square w-full rounded-card" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/3" />
        </li>
      ))}
    </ul>
  );
}

/** Grilă de produse cu încărcare infinită pe cursor (sentinel + buton de rezervă). */
export function CatalogGrid({ initial, filters, empty }: Props) {
  const t = useTranslations("shopBuyer.catalog");
  const locale = useLocale();
  const [items, setItems] = useState<CatalogCard[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setItems(initial.items);
    setCursor(initial.nextCursor);
    setFailed(false);
  }, [initial]);

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(buildUrl(filters, cursor, locale));
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as CatalogPage;
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...page.items.filter((p) => !seen.has(p.id))];
      });
      setCursor(page.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [cursor, filters, loading, locale]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || failed) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, failed, loadMore]);

  if (items.length === 0) {
    return <EmptyState icon={PackageSearch} title={empty.title} description={empty.description} action={empty.action} />;
  }

  return (
    <div className="space-y-4">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((p) => (
          <li key={p.id}>
            <ProductCard product={p} />
          </li>
        ))}
      </ul>
      {loading ? <CatalogGridSkeleton count={2} /> : null}
      {failed ? <ErrorState title={t("errorTitle")} onRetry={() => void loadMore()} /> : null}
      {cursor && !failed ? (
        <div ref={sentinel} className="flex justify-center">
          <Button variant="secondary" onClick={() => void loadMore()} loading={loading}>
            {t("loadMore")}
          </Button>
        </div>
      ) : (
        <p className="py-4 text-center text-xs text-subtle">{t("endOfList")}</p>
      )}
    </div>
  );
}
