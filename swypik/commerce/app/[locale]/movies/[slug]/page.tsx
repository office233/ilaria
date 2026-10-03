import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isEnabled } from "@/lib/feature-flags";
import { getSeriesBySlug } from "@/lib/movies/repository";
import { isSeriesPublic } from "@/lib/movies/access";
import SeriesClient from "./SeriesClient";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

const DESCRIPTION_MAX = 160;

export async function generateMetadata({ params }: { params: Promise<{ locale: string; slug: string }> }): Promise<Metadata> {
  const { locale, slug } = await params;
  const series = await getSeriesBySlug(slug).catch(() => null);
  if (!series || !isSeriesPublic(series)) return {};
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    alternates: localizedAlternates(locale, `/movies/${slug}`),
    title: `${series.title} — ${t("moviesTitle")}`,
    description: series.synopsis.slice(0, DESCRIPTION_MAX),
    openGraph: { images: series.poster_url ? [series.poster_url] : [] },
  };
}

export default async function SeriesPage({ params }: { params: Promise<{ slug: string }> }) {
  if (!isEnabled("movies")) notFound();
  const { slug } = await params;
  // 404 real pentru titluri inexistente (nu 200 cu pagină goală). Ciornele
  // rămân accesibile ownerului/adminului — API-ul decide vizibilitatea lor.
  const series = await getSeriesBySlug(slug).catch(() => null);
  if (!series) notFound();
  return <SeriesClient slug={slug} />;
}
