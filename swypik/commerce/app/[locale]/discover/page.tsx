import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import ChatInterface from "@/components/ChatInterface";
import { getDiscoverSections } from "@/lib/home/product-sections";
import { languagesForMetadata, localizedUrl } from "@/lib/seo/hreflang";

// ISR: datele vin din unstable_cache (revalidate 120), pagina nu citește
// cookies/headers → HTML pre-randat, regenerat în fundal.
export const revalidate = 120;
export const preferredRegion = "fra1";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "discover" });
  const canonical = localizedUrl(locale, "/discover");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical, languages: languagesForMetadata("/discover") },
    openGraph: {
      title: t("metaTitle"),
      description: t("metaDescription"),
      url: canonical,
      siteName: "Swypik",
      type: "website",
      images: [{ url: "/og-preview.webp", width: 1200, height: 630 }],
    },
  };
}

/**
 * Discover (tab-ul 2 din BottomNav): căutare, modulele ecosistemului și
 * feed-ul de oferte/produse (fostul home). Home-ul e acum feed-ul video.
 */
export default async function DiscoverPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("discover");
  const { trending, bestValue, topRated, offers } = await getDiscoverSections();
  return (
    <>
      <h1 className="sr-only">{t("title")}</h1>
      <ChatInterface
        initialTrending={trending.products}
        initialBestValue={bestValue.products}
        initialTopRated={topRated.products}
        initialOffers={offers}
      />
    </>
  );
}
