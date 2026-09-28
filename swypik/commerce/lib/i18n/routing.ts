// next-intl routing definition (Faza 1 — locale URLs).
// `as-needed`: RO (default) rămâne la `/`, restul primesc prefix `/en`, `/de`, etc.
// `localeDetection: false` — păstrăm controlul total prin cookie `swypik_locale`
// (selectorul globe + middleware-ul existent), nu vrem Accept-Language să forțeze
// redirect la prima vizită pentru utilizatorii vechi care au URL-uri RO indexate.
import { defineRouting } from "next-intl/routing";
import { LOCALES, DEFAULT_LOCALE } from "./config";

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: "as-needed",
  localeDetection: false,
  localeCookie: {
    name: "swypik_locale",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  },
});
