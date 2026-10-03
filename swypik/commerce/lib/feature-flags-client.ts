/**
 * Client-safe feature flags for MVP freeze.
 * Mirrors lib/feature-flags.ts but uses NEXT_PUBLIC_* env vars baked at build time.
 * Defaults match the server flags (false during freeze). To enable a flag in the
 * client bundle, set the corresponding NEXT_PUBLIC_FEATURE_* env var at build time
 * (docker-compose.prod.yml → build args → ARG/ENV) AND the matching server
 * FEATURE_* env var.
 *
 * IMPORTANT: Next inlinează în bundle-ul de browser DOAR accesările literale
 * `process.env.NEXT_PUBLIC_X`. O căutare cu numele variabilei calculat la
 * runtime rămâne `undefined` pe client indiferent de env — bug care a ținut
 * Movies și Music ascunse din meniu (2026-09-22). Aici se citește doar literal.
 */

function flag(value: string | undefined, defaultEnabled: boolean): boolean {
  if (value === undefined || value === "") return defaultEnabled;
  return value === '1' || value === 'true';
}

export const CLIENT_FEATURES = {
  dm: flag(process.env.NEXT_PUBLIC_FEATURE_DM, false),
  pushNotifications: flag(process.env.NEXT_PUBLIC_FEATURE_PUSH_NOTIFICATIONS, false),
  stripeConnect: flag(process.env.NEXT_PUBLIC_FEATURE_STRIPE_CONNECT, false),
  returns: flag(process.env.NEXT_PUBLIC_FEATURE_RETURNS, false),
  // Virtual Try-On: componenta e doar UI de previzualizare (fără AR real) — OFF.
  // Deprecated alias, kept for back-compat — prefer `virtualTryOn` below.
  tryOn: flag(process.env.NEXT_PUBLIC_FEATURE_TRY_ON, false),
  // Virtual Try-On (components/video/VirtualTryOnModal.tsx): a color/finish
  // preview only — no real camera/AR/face-detection. Audit 2026-09-24
  // (wave2-misc): entry point hidden unless this OR the legacy TRY_ON flag is on.
  virtualTryOn:
    flag(process.env.NEXT_PUBLIC_FEATURE_VIRTUAL_TRYON, false) ||
    flag(process.env.NEXT_PUBLIC_FEATURE_TRY_ON, false),
  // Catalog demo „viral" pentru selleri — trebuie setat împreună cu FEATURE_VIRAL_CATALOG (server).
  viralCatalog: flag(process.env.NEXT_PUBLIC_FEATURE_VIRAL_CATALOG, false),
  // Squad Buy a fost ȘTERS (2026-09-26). Rămâne constant false DOAR pentru că
  // CategorySidebar/EcosystemBar (navigație, altă echipă) îl mai citesc; șterge
  // cheia după ce acele linkuri dispar. Nu mai citește niciun env.
  // Swypik Cares (donații) — trebuie setat ÎMPREUNĂ cu FEATURE_CARES (server).
  cares: flag(process.env.NEXT_PUBLIC_FEATURE_CARES, false),
  // OFF by default — explicit opt-in via NEXT_PUBLIC_FEATURE_X=1 at build time,
  // mirroring the server-side default in lib/feature-flags.ts.
  movies: flag(process.env.NEXT_PUBLIC_FEATURE_MOVIES, false),
  music: flag(process.env.NEXT_PUBLIC_FEATURE_MUSIC, false),
  news: flag(process.env.NEXT_PUBLIC_FEATURE_NEWS, false),
  gaming: flag(process.env.NEXT_PUBLIC_FEATURE_GAMING, false),
  messenger: flag(process.env.NEXT_PUBLIC_FEATURE_MESSENGER, false),
  // Verticalele deja lansate — ON implicit, se pot ascunde din navigare cu
  // NEXT_PUBLIC_FEATURE_X=0 (meniul le ascunde, nu le afișează gri).
  // `go` oglindește FEATURE_GO (server, ON implicit).
  go: flag(process.env.NEXT_PUBLIC_FEATURE_GO, true),
  food: flag(process.env.NEXT_PUBLIC_FEATURE_FOOD, true),
  stays: flag(process.env.NEXT_PUBLIC_FEATURE_STAYS, true),
  fly: flag(process.env.NEXT_PUBLIC_FEATURE_FLY, true),
  // Rezervarea de zboruri (pereche cu FEATURE_FLY_BOOKING). OFF: /fly arată
  // „în curând / anunță-mă”, fără zboruri sau prețuri inventate.
  flyBooking: flag(process.env.NEXT_PUBLIC_FEATURE_FLY_BOOKING, false),
  live: flag(process.env.NEXT_PUBLIC_FEATURE_LIVE, true),
  missions: flag(process.env.NEXT_PUBLIC_FEATURE_MISSIONS, true),
} as const;

export type ClientFeatureName = keyof typeof CLIENT_FEATURES;

export function isEnabledClient(feature: ClientFeatureName): boolean {
  return CLIENT_FEATURES[feature];
}
