import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import GamingHubClient from "./GamingHubClient";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "gaming" });
  return { title: t("meta.title"), description: t("meta.description"), alternates: localizedAlternates(locale, "/gaming") };
}

export default function GamingHubPage() {
  if (!isEnabled("gaming")) notFound();
  return <GamingHubClient />;
}
