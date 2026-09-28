import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { logger } from "@/lib/logger";
import { getNewsFirstPage } from "@/lib/prewarm/news";
import { NEWS_PAGE_SIZE } from "@/lib/news/config";
import type { NewsArticleListItem } from "@/lib/news/repository";
import NewsListClient from "./NewsListClient";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "news" });
  return {
    title: t("meta.title"),
    description: t("meta.description"),
    openGraph: {
      title: t("meta.title"),
      description: t("meta.description"),
      type: "website",
    },
    alternates: localizedAlternates(locale, "/news"),
  };
}

/** Prima pagină e randată pe server (SEO: HTML-ul nu mai e gol); restul se încarcă pe client. */
export default async function NewsFeedPage({ params }: { params: Promise<{ locale: string }> }) {
  if (!isEnabled("news")) notFound();
  const [{ locale }, user] = await Promise.all([params, getAuthUser()]);
  let initial: { articles: NewsArticleListItem[]; hasMore: boolean } | null = null;
  try {
    const rows = await getNewsFirstPage(null);
    initial = { articles: rows.slice(0, NEWS_PAGE_SIZE), hasMore: rows.length > NEWS_PAGE_SIZE };
  } catch (err) {
    logger.warn({ err }, "[news] SSR first page failed — client will retry");
  }
  // Articolele sunt generate în română (lib/news/journalist-prompt.ts): pe celelalte limbi o anunțăm.
  return <NewsListClient isAdmin={user.isAdmin} initial={initial} showLanguageNotice={locale !== "ro"} />;
}
