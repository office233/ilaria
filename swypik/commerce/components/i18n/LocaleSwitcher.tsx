"use client";

import { useTransition } from "react";
import { useLocale } from "next-intl";
import { LOCALES, type Locale } from "@/lib/i18n/config";

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
  const currentLocale = useLocale() as Locale;
  const [isPending, startTransition] = useTransition();

  const handleChange = (locale: Locale) => {
    startTransition(async () => {
      try {
        await fetch("/api/i18n/preferences", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locale }),
        });
      } catch {
        // fallback: set cookie direct
        document.cookie = `swypik_locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
      }
      // Navighează la același path cu noul prefix de locale — un simplu reload
      // păstrează vechiul prefix din URL și limba nu se schimbă efectiv.
      const { pathname, search, hash } = window.location;
      const localePrefixRe = new RegExp(`^/(?:${LOCALES.join("|")})(?=/|$)`);
      const stripped = pathname.replace(localePrefixRe, "") || "/";
      window.location.href = `/${locale}${stripped === "/" ? "" : stripped}${search}${hash}`;
    });
  };

  return (
    <select
      aria-label="Language"
      disabled={isPending}
      value={currentLocale}
      onChange={(e) => handleChange(e.target.value as Locale)}
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
