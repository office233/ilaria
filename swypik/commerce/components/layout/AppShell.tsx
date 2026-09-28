// Documentul HTML comun (<html>/<head>/<body> + providers + chrome global).
// Randat de cele două "root layout"-uri reale:
//   - app/[locale]/layout.tsx  → locale din URL, fără request APIs → static/ISR
//   - app/(site)/layout.tsx    → rute fără prefix (admin, seller, auth, …),
//                                locale din cookie/DB/header → dinamic
// NU citi cookies()/headers() aici — ar face dinamică fiecare pagină [locale].
import { NextIntlClientProvider } from "next-intl";
import type { AbstractIntlMessages } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Currency, Locale } from "@/lib/i18n/config";
import { CurrencyProvider } from "@/components/i18n/CurrencyProvider";
import { safeJsonLd } from "@/lib/seo/json-ld";
import BottomNav from "@/components/BottomNav";
import MusicPlayerProvider from "@/components/music/MusicPlayerProvider";
import MiniPlayer from "@/components/music/MiniPlayer";
import FxRatesLoader from "@/components/i18n/FxRatesLoader";
import EmailVerifyBanner from "@/components/auth/EmailVerifyBanner";
import OnboardingGate from "@/components/onboarding/OnboardingGate";
import PushPrompt from "@/components/notifications/PushPrompt";
import GlobalCallHost from "@/components/messenger/Calls/GlobalCallHost";
import InstallPrompt from "@/components/pwa/InstallPrompt";
import ServiceWorkerRegistrar from "@/components/pwa/ServiceWorkerRegistrar";
import { WebVitalsReporter } from "@/components/perf/WebVitalsReporter";
import CookieBanner from "@/components/CookieBanner";
import ThemeProvider from "@/components/theme/ThemeProvider";
import AppMenuProvider from "@/components/nav/AppMenuProvider";
import { ToastProvider } from "@/components/ui/Toast";
import { interFont } from "@/components/layout/fonts";
import { APP_URL } from "@/lib/app-url";

export default async function AppShell({
  locale,
  messages,
  currency,
  children,
}: {
  locale: Locale;
  messages: AbstractIntlMessages;
  currency: Currency;
  children: React.ReactNode;
}) {
  const t = await getTranslations({ locale, namespace: "rootMeta" });
  return (
    <html lang={locale} className={interFont.variable} suppressHydrationWarning>
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Swypik" />
        {/* Fișierul real (public/manifest.json); /manifest.webmanifest e doar un 308 spre el. */}
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {process.env.GOOGLE_SITE_VERIFICATION ? (
          <meta name="google-site-verification" content={process.env.GOOGLE_SITE_VERIFICATION} />
        ) : null}
        {process.env.BING_SITE_VERIFICATION ? (
          <meta name="msvalidate.01" content={process.env.BING_SITE_VERIFICATION} />
        ) : null}
        {process.env.YANDEX_VERIFICATION ? (
          <meta name="yandex-verification" content={process.env.YANDEX_VERIFICATION} />
        ) : null}
        {process.env.PINTEREST_SITE_VERIFICATION ? (
          <meta name="p:domain_verify" content={process.env.PINTEREST_SITE_VERIFICATION} />
        ) : null}
        {process.env.FACEBOOK_DOMAIN_VERIFICATION ? (
          <meta name="facebook-domain-verification" content={process.env.FACEBOOK_DOMAIN_VERIFICATION} />
        ) : null}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd({
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "WebSite",
                  "@id": `${APP_URL}/#website`,
                  "url": `${APP_URL}/`,
                  "name": "Swypik",
                  "description": t("description"),
                  "inLanguage": locale,
                  "publisher": { "@id": `${APP_URL}/#organization` },
                  "potentialAction": {
                    "@type": "SearchAction",
                    "target": {
                      "@type": "EntryPoint",
                      "urlTemplate": `${APP_URL}/search?q={search_term_string}`
                    },
                    "query-input": "required name=search_term_string"
                  }
                },
                {
                  "@type": "Organization",
                  "@id": `${APP_URL}/#organization`,
                  "name": "Swypik",
                  "url": `${APP_URL}/`,
                  "logo": `${APP_URL}/apple-touch-icon.png`,
                  "sameAs": []
                }
              ]
            })
          }}
        />
      </head>
      <body className="bg-canvas font-sans text-fg antialiased" suppressHydrationWarning>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-lg focus:bg-fg focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-fg-inverse focus:shadow-elev-3 focus:outline-none focus:ring-2"
        >
          {t("skipToContent")}
        </a>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider>
            <ToastProvider>
              <AppMenuProvider>
                <CurrencyProvider initial={currency}>
                  <FxRatesLoader />
                  <EmailVerifyBanner />
                  <OnboardingGate />
                  <MusicPlayerProvider>
                    {/* padding-bottom pentru BottomNav: CSS (--bottom-inset), vezi globals.css */}
                    <div id="main-content">{children}</div>
                    <MiniPlayer />
                    <BottomNav />
                  </MusicPlayerProvider>
                  {/* Soneria apelurilor primite în tot app-ul (null fără NEXT_PUBLIC_CALLS_ENABLED). */}
                  <GlobalCallHost />
                  <PushPrompt />
                  {/* Un singur overlay odată: InstallPrompt apare doar după alegerea cookie și după implicare. */}
                  <InstallPrompt />
                  <CookieBanner />
                  <ServiceWorkerRegistrar />
                  {/* RUM propriu, anonim, fără cookie-uri (lib/perf) — p75 în /admin/health. */}
                  <WebVitalsReporter />
                </CurrencyProvider>
              </AppMenuProvider>
            </ToastProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
