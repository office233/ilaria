import ResetConsentButton from "./ResetConsentButton";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PRIVACY_EMAIL } from "@/lib/contact";
import { localizedAlternates } from "@/lib/seo/hreflang";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "legalCookies" });
  return {
    alternates: localizedAlternates(locale, "/legal/cookies"),
    title: t("metaTitle"),
    description: t("metaDescription"),
  };
}

export default async function CookiesPage() {
  const t = await getTranslations("legalCookies");
  return (
    <>
      <h1>{t("pageTitle")}</h1>
      <p><strong>{t("lastUpdatedLabel")}</strong> {t("lastUpdatedDate")}</p>

      <h2>{t("whatAreCookiesTitle")}</h2>
      <p>{t("whatAreCookiesBody")}</p>

      <h2>{t("categoriesTitle")}</h2>

      <h3>{t("essentialTitle")}</h3>
      <ul>
        <li><code>swypik_session</code> — {t("cookieSession")}</li>
        <li><code>seller_session</code> — {t("cookieSeller")}</li>
        <li><code>anon_session</code> — {t("cookieAnon")}</li>
        <li><code>theme</code> — {t("cookieTheme")}</li>
        <li><code>cookie_consent</code> — {t("cookieConsent")}</li>
      </ul>
      <p>{t("essentialNote")}</p>

      <h3>{t("functionalTitle")}</h3>
      <ul>
        <li>{t("functionalItem")}</li>
      </ul>

      <h3>{t("analyticsTitle")}</h3>
      <ul>
        <li>{t("analyticsItem")}</li>
      </ul>

      <h2>{t("thirdPartyTitle")}</h2>
      <ul>
        <li><strong>Stripe</strong> — {t("stripeNote")}</li>
      </ul>

      <h2>{t("manageTitle")}</h2>
      <p>{t("manageBody")}</p>
      <p>{t("manageBrowserIntro")}</p>
      <ul>
        <li>{t("manageChrome")}</li>
        <li>{t("manageFirefox")}</li>
        <li>{t("manageSafari")}</li>
      </ul>
      <p>{t("manageWarning")}</p>

      <h2>{t("preferencesTitle")}</h2>
      <p><ResetConsentButton /></p>

      <h2>{t("contactTitle")}</h2>
      <p>{t("contactQuestions")} <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a></p>
    </>
  );
}
