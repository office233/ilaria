/**
 * Când oferim instalarea PWA — un singur overlay odată și doar după implicare:
 *  1. utilizatorul a ales deja la bannerul de cookie (altfel ar apărea două overlay-uri);
 *  2. e a doua vizită SAU a văzut cel puțin 3 pagini în sesiunea curentă;
 *  3. nu a refuzat în ultimele 14 zile.
 */
export const INSTALL_REPROMPT_MS = 14 * 24 * 60 * 60 * 1000;
export const INSTALL_MIN_VISITS = 2;
export const INSTALL_MIN_PAGEVIEWS = 3;

export const STORAGE = {
  dismissed: "swypik_pwa_dismissed",
  dismissedAt: "swypik_pwa_dismissed_at",
  visits: "swypik_visit_count",
  sessionMarker: "swypik_session_counted",
  pageViews: "swypik_session_pageviews",
  cookieConsent: "swypik_cookie_consent",
} as const;

export type InstallGateInput = {
  consentDecided: boolean;
  visits: number;
  sessionPageViews: number;
  dismissedAt: number | null;
  now: number;
};

export function shouldOfferInstall(input: InstallGateInput): boolean {
  if (!input.consentDecided) return false;
  if (input.dismissedAt && input.now - input.dismissedAt < INSTALL_REPROMPT_MS) return false;
  return input.visits >= INSTALL_MIN_VISITS || input.sessionPageViews >= INSTALL_MIN_PAGEVIEWS;
}

type KV = Pick<Storage, "getItem" | "setItem">;

function readInt(store: KV, key: string): number {
  const n = Number(store.getItem(key) || "0");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Numără o vizită per sesiune de browser (localStorage + marker în sessionStorage). */
export function countVisit(local: KV, session: KV): number {
  const visits = readInt(local, STORAGE.visits);
  if (session.getItem(STORAGE.sessionMarker) === "1") return visits;
  session.setItem(STORAGE.sessionMarker, "1");
  local.setItem(STORAGE.visits, String(visits + 1));
  return visits + 1;
}

/** Incrementează numărul de pagini văzute în sesiunea curentă. */
export function countPageView(session: KV): number {
  const views = readInt(session, STORAGE.pageViews) + 1;
  session.setItem(STORAGE.pageViews, String(views));
  return views;
}

export function readDismissedAt(local: KV): number | null {
  if (local.getItem(STORAGE.dismissed) !== "1") return null;
  const at = readInt(local, STORAGE.dismissedAt);
  return at || null;
}
