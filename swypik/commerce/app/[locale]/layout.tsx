// Sub-layout pentru rutele user-facing localizate (`app/[locale]/...`).
// Roluri:
//   1. activează static rendering pentru paginile dinamice (`setRequestLocale`)
//   2. validează `params.locale`
//   3. expune `generateStaticParams()` pentru build-time render
//   4. NU setează `alternates` (canonical/hreflang) — le setează fiecare pagină
//      publică prin `localizedAlternates(locale, path)` din lib/seo/hreflang
//   5. e root layout-ul real al acestor rute: randează <html lang={locale}>
//      prin AppShell. Nu folosește cookies()/headers(), deci paginile care nu
//      citesc ele însele request APIs pot fi statice / ISR. Moneda din cookie
//      e aplicată pe client (CurrencyProvider), după hidratare.
import { notFound } from "next/navigation";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import type { Metadata } from "next";
import { routing } from "@/lib/i18n/routing";
import { CURRENCY_BY_LOCALE, type Locale } from "@/lib/i18n/config";
import AppShell from "@/components/layout/AppShell";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

const OG_LOCALE: Record<string, string> = {
  ro: "ro_RO",
  en: "en_US",
  es: "es_ES",
  fr: "fr_FR",
  de: "de_DE",
  pt: "pt_PT",
  it: "it_IT",
};

// Metadata default (title/description traduse + hreflang) pentru ROOT-ul
// fiecărei limbi (`/`, `/en`, etc). Locale-ul e explicit (din params), deci
// getTranslations() nu citește header-ul middleware-ului → rămâne static.
// Paginile interne (cu propriul `generateMetadata`) suprascriu title/description
// și trebuie să apeleze `localizedAlternates(locale, pathname)` pentru alternates.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "rootMeta" });
  return {
    title: t("title"),
    description: t("description"),
    // Fără `alternates` aici: ar fi moștenit de fiecare pagină fără metadata
    // proprie (canonical + hreflang spre homepage). Fiecare pagină publică își
    // setează `alternates: localizedAlternates(locale, path)`.
    openGraph: {
      title: t("title"),
      description: t("ogDescription"),
      type: "website",
      locale: OG_LOCALE[locale] ?? "ro_RO",
      siteName: "Swypik",
      images: [{ url: "/og-preview.webp", width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: t("title"),
      description: t("twitterDescription"),
      images: ["/og-preview.webp"],
    },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as Locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const messages = await getMessages();
  return (
    <AppShell
      locale={locale as Locale}
      messages={messages}
      currency={CURRENCY_BY_LOCALE[locale as Locale] ?? "RON"}
    >
      {children}
    </AppShell>
  );
}
