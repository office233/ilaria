import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import { getArticleBySlug, incrementViewCount } from "@/lib/news/repository";
import { plainSummary } from "@/lib/news/text";
import ArticleClient from "./ArticleClient";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

const DESCRIPTION_MAX = 160;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isEnabled("news")) return {};

  const article = await getArticleBySlug(slug).catch(() => null);
  if (!article) return {};

  const description = plainSummary(article.summary_tldr, DESCRIPTION_MAX);
  return {
    title: article.title,
    description,
    openGraph: {
      title: article.title,
      description,
      type: "article",
      images: article.cover_image_url ? [article.cover_image_url] : [],
      publishedTime: article.published_at,
    },
    alternates: localizedAlternates(locale, `/news/${slug}`),
  };
}

export default async function ArticleReaderPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  if (!isEnabled("news")) notFound();

  const { slug } = await params;
  const article = await getArticleBySlug(slug);
  if (!article) notFound();

  // Best-effort view count, once per page render (never blocks the response).
  void incrementViewCount(article.id);

  return <ArticleClient article={article} />;
}
