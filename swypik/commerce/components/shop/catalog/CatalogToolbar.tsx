"use client";

import { useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { IconButton } from "@/components/ui/IconButton";
import { Select } from "@/components/ui/Select";
import { Link, usePathname, useRouter } from "@/lib/i18n/navigation";
import { CATALOG_SORTS, type CatalogSort } from "@/lib/shop/schemas";
import { cn } from "@/lib/ui/cn";

export type CategoryChip = { slug: string; name: string };

type Props = {
  sort: CatalogSort;
  q?: string;
  /** Afișează căutarea (pe /shop). În categorii doar sortarea. */
  withSearch?: boolean;
  chips?: CategoryChip[];
  activeCategory?: string;
};

/** Căutare + sortare + categorii ca chip-uri; totul trăiește în URL (partajabil, back funcționează). */
export function CatalogToolbar({ sort, q = "", withSearch = false, chips = [], activeCategory }: Props) {
  const t = useTranslations("shopBuyer.catalog");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(q);

  const update = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [k, v] of Object.entries(patch)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    update({ q: query.trim() || null });
  };

  const chipHref = (slug: string | null) => {
    const sp = new URLSearchParams(searchParams?.toString() ?? "");
    if (slug) sp.set("category", slug);
    else sp.delete("category");
    const qs = sp.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {withSearch ? (
          <form role="search" onSubmit={onSubmit} className="min-w-0 flex-1">
            <label className="sr-only" htmlFor="shop-search">
              {t("searchLabel")}
            </label>
            <Input
              id="shop-search"
              type="search"
              enterKeyHint="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              leadingIcon={<Search aria-hidden />}
              trailing={
                query ? (
                  <IconButton
                    label={t("clearSearch")}
                    size="sm"
                    onClick={() => {
                      setQuery("");
                      update({ q: null });
                    }}
                  >
                    <X aria-hidden />
                  </IconButton>
                ) : null
              }
            />
          </form>
        ) : null}
        <div className={cn(withSearch ? "w-40 shrink-0" : "w-full sm:w-56")}>
          <label className="sr-only" htmlFor="shop-sort">
            {t("sortLabel")}
          </label>
          <Select
            id="shop-sort"
            value={sort}
            onChange={(e) => update({ sort: e.target.value === "newest" ? null : e.target.value })}
            options={CATALOG_SORTS.map((s) => ({ value: s, label: t(`sort_${s}`) }))}
          />
        </div>
      </div>
      {chips.length > 0 ? (
        <nav aria-label={t("categoriesLabel")} className="no-scrollbar -mx-gutter flex gap-2 overflow-x-auto px-gutter">
          {[{ slug: "", name: t("allCategories") }, ...chips].map((c) => {
            const active = (activeCategory ?? "") === c.slug;
            return (
              <Link
                key={c.slug || "all"}
                href={chipHref(c.slug || null)}
                scroll={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-11 shrink-0 items-center rounded-full border px-4 text-sm font-medium transition-colors duration-fast",
                  active ? "border-brand bg-brand text-brand-fg" : "border-subtle bg-surface text-fg hover:bg-surface-2",
                )}
              >
                {c.name}
              </Link>
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}
