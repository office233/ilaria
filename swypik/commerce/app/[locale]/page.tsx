import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import ExploreClient from "./explore/ExploreClient";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";
import { localizedAlternates, localizedUrl } from "@/lib/seo/hreflang";
import { APP_URL } from "@/lib/app-url";
import { safeJsonLd } from "@/lib/seo/json-ld";

// Home = feed-ul video vertical (decizia owner-ului). Pagina e statică: shell-ul
// e pre-randat, clipurile se încarcă pe client prin lib/feed/client/feed-source.ts
// (sesiune + seen-set personal, deci nu are sens în HTML-ul cache-uit).
export const revalidate = 3600;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    title: t("homeTitle"),
    description: t("homeDescription"),
    alternates: localizedAlternates(locale, "/"),
    openGraph: {
      title: t("homeOgTitle"),
      description: t("homeOgDescription"),
      url: localizedUrl(locale, "/"),
      siteName: "Swypik",
      type: "website",
      locale,
      images: [{ url: "/og-preview.webp", width: 1200, height: 630, alt: t("homeOgTitle") }],
    },
    twitter: {
      card: "summary_large_image",
      title: t("homeOgTitle"),
      description: t("homeOgDescription"),
      images: ["/og-preview.webp"],
    },
  };
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  // Fără apelul ăsta getTranslations() poate citi header-ul middleware-ului → pagină dinamică.
  setRequestLocale(locale);
  const t = await getTranslations("page");
  const t2 = await getTranslations("rootMeta");

  const orgJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Swypik",
    url: `${APP_URL}/`,
    logo: `${APP_URL}/icon-512.png`,
    description: t2("description"),
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(orgJsonLd) }} />
      <header className="sr-only">
        <h1>{t("swypikCumparaPrinVideo")}</h1>
        <p>{t("descoperaProdusePopulareOferte")}</p>
      </header>
      <ImmersiveSurface fullscreen>
        <ExploreClient />
      </ImmersiveSurface>
    </>
  );
}
