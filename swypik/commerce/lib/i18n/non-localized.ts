// Rute care NU trăiesc sub `app/[locale]` (back-office, auth, API, sitemap-uri).
// Un <Link> localizat (next-intl) ar adăuga prefixul de limbă (/en/admin → 404),
// așa că pentru acestea folosim `next/link` simplu. Lista oglindește
// Sursa unică: o folosește și middleware.ts.
export const NON_LOCALIZED_PREFIXES = [
  "/api",
  "/admin",
  "/seller",
  "/auth",
  "/onboarding",
  "/creator",
  "/feed.xml",
  "/sitemap.xml",
  "/static-sitemap.xml",
  "/products/sitemap",
  "/videos/sitemap.xml",
  "/robots.txt",
  "/unsubscribe",
  "/r",
  "/courier",
  "/cauze",
  "/.well-known",
] as const;

/** true dacă `href` (path intern, fără prefix de limbă) nu trebuie localizat. */
export function isNonLocalizedPath(href: string): boolean {
  if (!href.startsWith("/")) return true; // extern / mailto / tel / relativ — nu-l atingem
  const path = href.split(/[?#]/)[0];
  return NON_LOCALIZED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}
