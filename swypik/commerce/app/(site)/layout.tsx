// Root layout pentru rutele FĂRĂ prefix de limbă (admin, seller, creator,
// auth, onboarding, …). Locale-ul vine din cookie / DB / Accept-Language
// (lib/i18n/request.ts), deci aceste rute rămân dinamice — ca înainte.
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import {
  CURRENCY_BY_LOCALE,
  CURRENCY_COOKIE,
  isCurrency,
  type Currency,
  type Locale,
} from "@/lib/i18n/config";
import AppShell from "@/components/layout/AppShell";

const OG_LOCALE: Record<string, string> = {
  ro: "ro_RO",
  en: "en_US",
  es: "es_ES",
  fr: "fr_FR",
  de: "de_DE",
  pt: "pt_PT",
  it: "it_IT",
};

// Rutele fără prefix (admin, seller, auth, …) sunt deja dinamice (cookie/DB/
// header pentru locale), deci getLocale() aici nu costă nimic în plus.
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: "rootMeta" });
  return {
    title: t("title"),
    description: t("description"),
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

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const locale = (await getLocale()) as Locale;
  const messages = await getMessages();
  const cookieStore = await cookies();
  const cookieCurrency = cookieStore.get(CURRENCY_COOKIE)?.value;
  const currency: Currency = isCurrency(cookieCurrency)
    ? cookieCurrency
    : CURRENCY_BY_LOCALE[locale] ?? "RON";
  return (
    <AppShell locale={locale} messages={messages} currency={currency}>
      {children}
    </AppShell>
  );
}
