"use client";

import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { LOCALES, type Locale } from "@/lib/i18n/config";
import { saveI18nPreference } from "./preferences";

type LocaleMeta = { label: string; flag: string };

const META: Record<Locale, LocaleMeta> = {
  ro: { label: "Română", flag: "🇷🇴" },
  en: { label: "English", flag: "🇬🇧" },
  es: { label: "Español", flag: "🇪🇸" },
  fr: { label: "Français", flag: "🇫🇷" },
  de: { label: "Deutsch", flag: "🇩🇪" },
  pt: { label: "Português", flag: "🇵🇹" },
  it: { label: "Italiano", flag: "🇮🇹" },
};

export default function LocaleSwitcher({ className }: { className?: string }) {
  const t = useTranslations("common");
  const currentLocale = useLocale() as Locale;
  const [isPending, setPending] = useState(false);
  const pending = useRef(false);

  const handleChange = async (locale: Locale) => {
    if (pending.current || locale === currentLocale) return;
    pending.current = true;
    setPending(true);
    try {
      await saveI18nPreference({ locale });
      // Navighează la același path cu noul prefix de locale — un simplu reload
      // păstrează vechiul prefix din URL și limba nu se schimbă efectiv.
      const { pathname, search, hash } = window.location;
      const localePrefixRe = new RegExp(`^/(?:${LOCALES.join("|")})(?=/|$)`);
      const stripped = pathname.replace(localePrefixRe, "") || "/";
      window.location.href = `/${locale}${stripped === "/" ? "" : stripped}${search}${hash}`;
    } finally {
      pending.current = false;
      setPending(false);
    }
  };

  return (
    <select
      aria-label={t("language")}
      disabled={isPending}
      value={currentLocale}
      onChange={(e) => void handleChange(e.target.value as Locale)}
      className={className}
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {META[l].flag} {META[l].label}
        </option>
      ))}
    </select>
  );
}
