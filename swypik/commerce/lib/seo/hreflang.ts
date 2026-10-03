// Helper SEO: generează alternate URLs (hreflang) pentru orice path.
// Folosit în:
//   - app/static-sitemap.xml/route.ts (adaugă xhtml:link per locale × URL)
//   - metadata.alternates.languages al paginilor din `app/[locale]/...`
//
// Convenții:
//   - DEFAULT_LOCALE (ro) NU primește prefix → canonical & x-default URL = `${BASE}${path}`
//   - Restul locale-urilor: `${BASE}/{locale}${path}`
//   - `path` trebuie să fie forma canonică (fără prefix), e.g. "/explore", "/product/123"
import { LOCALES, DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config";
import { APP_URL } from "@/lib/app-url";

const BASE_URL = APP_URL;

// BCP-47 codes (Google hreflang acceptă atât "en" cât și "en-US"; folosim doar codul scurt).
const HREFLANG_BY_LOCALE: Record<Locale, string> = {
  ro: "ro",
  en: "en",
  es: "es",
  fr: "fr",
  de: "de",
  pt: "pt",
  it: "it",
};

export interface AlternateEntry {
  hreflang: string;
  href: string;
}

/**
 * Construiește lista de alternate URLs pentru un path dat.
 * Include și `x-default` (RO, fără prefix).
 */
export function buildAlternates(path: string): AlternateEntry[] {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const out: AlternateEntry[] = [];

  for (const locale of LOCALES) {
    const href =
      locale === DEFAULT_LOCALE
        ? `${BASE_URL}${cleanPath}`
        : `${BASE_URL}/${locale}${cleanPath === "/" ? "" : cleanPath}`;
    out.push({ hreflang: HREFLANG_BY_LOCALE[locale], href });
  }

  // x-default = forma fără prefix (RO).
  out.push({
    hreflang: "x-default",
    href: `${BASE_URL}${cleanPath}`,
  });

  return out;
}

/**
 * Returnează `languages` object compatibil cu `Metadata.alternates.languages`
 * din Next.js. Conține toate locale-urile (fără `x-default`, care e separat).
 */
export function languagesForMetadata(path: string): Record<string, string> {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const out: Record<string, string> = {};
  for (const locale of LOCALES) {
    const href =
      locale === DEFAULT_LOCALE
        ? `${BASE_URL}${cleanPath}`
        : `${BASE_URL}/${locale}${cleanPath === "/" ? "" : cleanPath}`;
    out[HREFLANG_BY_LOCALE[locale]] = href;
  }
  out["x-default"] = `${BASE_URL}${cleanPath}`;
  return out;
}

/**
 * URL absolut al unui path pentru o limbă dată (RO = fără prefix).
 * Limbile necunoscute cad pe DEFAULT_LOCALE.
 */
export function localizedUrl(locale: string, path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const loc = (LOCALES as readonly string[]).includes(locale) ? locale : DEFAULT_LOCALE;
  if (loc === DEFAULT_LOCALE) return `${BASE_URL}${cleanPath}`;
  return `${BASE_URL}/${loc}${cleanPath === "/" ? "" : cleanPath}`;
}

/**
 * `Metadata.alternates` pentru o pagină localizată: canonical = URL-ul ei
 * absolut în limba curentă (self-canonical), plus hreflang pentru toate limbile.
 * `path` = forma fără prefix de limbă, cu parametrii reali (ex. `/product/123`).
 */
export function localizedAlternates(
  locale: string,
  path: string,
): { canonical: string; languages: Record<string, string> } {
  return { canonical: localizedUrl(locale, path), languages: languagesForMetadata(path) };
}

/**
 * Construiește fragmentul XML `<xhtml:link rel="alternate" hreflang>` pentru
 * inclusiv într-un sitemap (un `<url>` entry).
 * Returnează lista de tag-uri, fără indentare; caller-ul le concatenează.
 */
export function buildSitemapHreflangTags(path: string): string {
  return buildAlternates(path)
    .map(
      (a) =>
        `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${escapeXml(a.href)}" />`,
    )
    .join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
