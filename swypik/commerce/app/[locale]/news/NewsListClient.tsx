"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Newspaper, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import NewsCard from "@/components/news/NewsCard";
import NextLink from "next/link";
import { NEWS_CATEGORY_FILTERS, type NewsCategoryFilter } from "@/lib/news/categories";
import type { NewsArticleListItem } from "@/lib/news/repository";

type ListState = { status: "loading" } | { status: "error" } | { status: "ready"; articles: NewsArticleListItem[]; hasMore: boolean; loadingMore: boolean };

async function fetchPage(category: NewsCategoryFilter, offset: number): Promise<{ articles: NewsArticleListItem[]; hasMore: boolean }> {
  const qs = new URLSearchParams({ offset: String(offset) });
  if (category !== "all") qs.set("category", category);
  const res = await fetch(`/api/news?${qs.toString()}`);
  const d = await res.json();
  if (!res.ok || !d.ok) throw new Error(String(res.status));
  return { articles: d.articles ?? [], hasMore: Boolean(d.hasMore) };
}

type Props = {
  isAdmin: boolean;
  /** Prima pagină (categoria „all”) randată pe server. */
  initial?: { articles: NewsArticleListItem[]; hasMore: boolean } | null;
  showLanguageNotice?: boolean;
};

export default function NewsListClient({ isAdmin, initial = null, showLanguageNotice = false }: Props) {
  const t = useTranslations("news");
  const [category, setCategory] = useState<NewsCategoryFilter>("all");
  const [state, setState] = useState<ListState>(initial ? { status: "ready", ...initial, loadingMore: false } : { status: "loading" });
  const usedInitial = useRef(Boolean(initial));

  const load = useCallback(() => {
    // Prima randare folosește lista de pe server; o schimbare de categorie reîncarcă.
    if (usedInitial.current && category === "all") {
      usedInitial.current = false;
      return;
    }
    usedInitial.current = false;
    setState({ status: "loading" });
    fetchPage(category, 0)
      .then((p) => setState({ status: "ready", ...p, loadingMore: false }))
      .catch(() => setState({ status: "error" }));
  }, [category]);
  useEffect(load, [load]);

  const loadMore = () => {
    if (state.status !== "ready") return;
    setState({ ...state, loadingMore: true });
    fetchPage(category, state.articles.length)
      .then((p) => {
        const seen = new Set(state.articles.map((a) => a.id));
        setState({ status: "ready", articles: [...state.articles, ...p.articles.filter((a) => !seen.has(a.id))], hasMore: p.hasMore, loadingMore: false });
      })
      .catch(() => setState({ ...state, loadingMore: false }));
  };

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader
        title={t("list.title")}
        actions={isAdmin ? (
          <IconButton asChild label={t("list.adminReview")}>
            <NextLink href="/admin/news"><ShieldCheck className="h-5 w-5" aria-hidden /></NextLink>
          </IconButton>
        ) : null}
      >
        <Tabs value={category} onValueChange={(v) => setCategory(v as NewsCategoryFilter)}>
          <TabsList variant="pill">
            {NEWS_CATEGORY_FILTERS.map((c) => <TabsTrigger key={c} value={c}>{t(`categories.${c}`)}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      </PageHeader>

      <div className="mx-auto max-w-3xl space-y-3 px-gutter py-4">
        <p className="text-xs text-subtle">{t("list.disclaimer")}</p>
        {showLanguageNotice ? <p className="text-xs text-muted">{t("list.languageNotice")}</p> : null}
        {state.status === "loading" ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32 w-full rounded-card" />)
        ) : state.status === "error" ? (
          <ErrorState onRetry={load} />
        ) : state.articles.length === 0 ? (
          <EmptyState icon={Newspaper} title={t("list.emptyTitle")} description={t("list.emptyBody")} />
        ) : (
          <>
            <ul className="space-y-3">
              {state.articles.map((a) => <li key={a.id}><NewsCard article={a} /></li>)}
            </ul>
            {state.hasMore && (
              <Button variant="secondary" block loading={state.loadingMore} onClick={loadMore}>{t("list.loadMore")}</Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
