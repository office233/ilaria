/**
 * Explore — RSC shell (metadata + ecran imersiv). Feed-ul interactiv: ExploreClient.tsx
 * → components/explore/FeedScreen.tsx.
 */
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import ExploreClient from "./ExploreClient";
import LiveBadge from "@/components/live/LiveBadge";
import { isLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import { languagesForMetadata, localizedUrl } from "@/lib/seo/hreflang";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";

export const dynamic = "force-dynamic";


// Bug fix (i18n/UI audit 2026-09-24): metadata previously read the locale
// cookie instead of the route's own [locale] segment, so /en/explore could
// render the Romanian <title> whenever the cookie was stale or unset.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = await getTranslations({ locale, namespace: "explore" });
  const meta = { title: t("metaTitle"), description: t("metaDescription") };
  // Canonical-ul fiecărei limbi e propria ei adresă (/en/explore…), nu mereu /explore.
  const languages = languagesForMetadata("/explore");
  const canonical = localizedUrl(locale, "/explore");
  return {
    title: meta.title,
    description: meta.description,
    alternates: { canonical, languages },
    openGraph: {
      title: meta.title,
      description: meta.description,
      url: canonical,
      siteName: "Swypik",
      type: "website",
      images: [{ url: "/og-preview.webp", width: 1200, height: 630, alt: "Swypik Explore" }],
    },
    twitter: {
      card: "summary_large_image",
      title: meta.title,
      description: meta.description,
      images: ["/og-preview.webp"],
    },
  };
}

export default async function ExplorePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = sp.taxonomy_node_slug ?? sp.category ?? "";
  const category = Array.isArray(raw) ? (raw[0] || "") : (raw || "");
  // Clipurile se încarcă pe client (lib/feed/client/feed-source.ts): seen-set și
  // snapshot-ul de ranking sunt per viewer, deci nu au ce căuta în HTML-ul randat.
  return (
    <>
      <LiveBadge />
      <ImmersiveSurface fullscreen>
        <ExploreClient initialCategory={category} />
      </ImmersiveSurface>
    </>
  );
}
