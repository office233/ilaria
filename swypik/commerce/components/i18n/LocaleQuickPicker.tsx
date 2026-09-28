"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Globe } from "lucide-react";
import { useLocale } from "next-intl";
// Navigație LOCALIZATĂ: getPathname({ href, locale }) reconstruiește URL-ul cu
// prefixul corect al limbii alese (as-needed). Navigarea e HARD (full reload):
// NextIntlClientProvider + <html lang> stau în app/layout.tsx, deasupra
// [locale], iar o navigare soft nu re-randează root layout-ul — BottomNav și
// componentele client rămâneau în limba veche (audit 2026-09-24).
import { usePathname, getPathname } from "@/lib/i18n/navigation";
import { LOCALES, type Locale } from "@/lib/i18n/config";

const META: Record<Locale, { label: string; flag: string }> = {
  ro: { label: "Română", flag: "🇷🇴" },
  en: { label: "English", flag: "🇬🇧" },
  es: { label: "Español", flag: "🇪🇸" },
  fr: { label: "Français", flag: "🇫🇷" },
  de: { label: "Deutsch", flag: "🇩🇪" },
  pt: { label: "Português", flag: "🇵🇹" },
  it: { label: "Italiano", flag: "🇮🇹" },
};

/**
 * Compact globe button → dropdown with all locales.
 * Persists choice via /api/i18n/preferences (cookie + DB if user logged in).
 */
export default function LocaleQuickPicker({
  className = "",
  variant = "dark",
}: {
  className?: string;
  variant?: "dark" | "light";
}) {
  const currentLocale = useLocale() as Locale;
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pick = (loc: Locale) => {
    setOpen(false);
    if (loc === currentLocale) return;
    startTransition(async () => {
      // Persistă preferința (cookie + DB dacă e logat) — best-effort, cu cookie
      // ca plasă dacă endpoint-ul pică.
      try {
        await fetch("/api/i18n/preferences", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locale: loc }),
        });
      } catch {
        document.cookie = `swypik_locale=${loc}; Path=/; Max-Age=31536000; SameSite=Lax`;
      }
      // Navighează la ACELAȘI path în noua limbă — getPathname pune/scoate
      // prefixul de locale (as-needed): /explore → /en/explore, iar la revenirea
      // pe ro scoate prefixul. Full reload ca să se re-randeze root layout-ul.
      const { search, hash } = window.location;
      window.location.assign(`${getPathname({ href: pathname, locale: loc })}${search}${hash}`);
    });
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        aria-label="Language"
        disabled={isPending}
        onClick={() => setOpen((v) => !v)}
          className={
            variant === "light"
              ? "relative inline-flex h-11 items-center justify-center gap-2 rounded-full bg-black/5 px-4 text-[13px] font-bold text-[#0D0D0D] hover:bg-black/10 focus:outline-none focus:ring-2 focus:ring-black/20"
              : "relative inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-white/40"
          }
      >
        <Globe className="h-5 w-5" />
          {variant === "light" ? (
            <span>{META[currentLocale]?.flag} {META[currentLocale]?.label}</span>
          ) : (
            <span className="absolute -bottom-0.5 -right-0.5 text-[10px] leading-none">
              {META[currentLocale]?.flag}
            </span>
          )}
      </button>
      {open && (
          <div
            className={
              variant === "light"
                ? "absolute bottom-full left-1/2 z-50 mb-2 w-44 -translate-x-1/2 rounded-xl border border-black/10 bg-white py-1 shadow-xl"
                : "absolute right-0 mt-2 w-44 rounded-xl border border-white/10 bg-black/95 shadow-lg backdrop-blur-xl z-50 py-1"
            }
          >
          {LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => pick(l)}
                className={
                  variant === "light"
                    ? `flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-black/5 ${l === currentLocale ? "font-bold text-[#0D0D0D]" : "text-[#3C3C43]"}`
                    : `w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-white/10 ${l === currentLocale ? "text-white font-medium" : "text-white/80"}`
                }
            >
              <span>{META[l].flag}</span>
              <span>{META[l].label}</span>
              {l === currentLocale && <span className="ml-auto text-xs text-emerald-400">●</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
