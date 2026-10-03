import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import MoviesClient from "./MoviesClient";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return { title: t("moviesTitle"), description: t("moviesDescription"), alternates: localizedAlternates(locale, "/movies") };
}

export default function MoviesPage() {
  if (!isEnabled("movies")) notFound();
  return <MoviesClient />;
}
