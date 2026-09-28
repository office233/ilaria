/**
 * Feature flags pentru MVP freeze.
 * Modulele dezactivate aici raman in cod dar nu mai sunt accesibile public.
 * Reactivare: schimba env var in .env.production si restart container.
 */

function flag(name: string, defaultEnabled: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultEnabled;
  return v === '1' || v === 'true';
}

export const FEATURES = {
  dm: flag('FEATURE_DM', false),
  pushNotifications: flag('FEATURE_PUSH_NOTIFICATIONS', false),
  stripeConnect: flag('FEATURE_STRIPE_CONNECT', false),
  fulfillment: flag('FEATURE_FULFILLMENT', false),
  returns: flag('FEATURE_RETURNS', false),
  emailMarketing: flag('FEATURE_EMAIL_MARKETING', false),
  seoPages: flag('FEATURE_SEO_PAGES', false),
  aiChatFull: flag('FEATURE_AI_CHAT_FULL', false),
  // killswitch verticala Go (commit 327586fc îl folosea fără să-l declare)
  go: flag('FEATURE_GO', true),
  // Catalog demo de produse "virale" pentru selleri — date de exemplu, nu un
  // feed real de furnizor. OFF până există unul.
  viralCatalog: flag('FEATURE_VIRAL_CATALOG', false),
  // Swypik Cares (donații): OFF până există un partener ONG (Stripe Connect,
  // fără custodie de fonduri). Codul rămâne; paginile dau 404, API-urile 410.
  cares: flag('FEATURE_CARES', false),
  // Swypik Movies/Music/News/Gaming/Messenger — OFF by default, explicit
  // opt-in via env (FEATURE_X=1) once the module is verified ready for prod.
  movies: flag('FEATURE_MOVIES', false),
  music: flag('FEATURE_MUSIC', false),
  news: flag('FEATURE_NEWS', false),
  gaming: flag('FEATURE_GAMING', false),
  messenger: flag('FEATURE_MESSENGER', false),
  // Swypik Fly: fără furnizor de zboruri (audit fly.md) → /fly e „în curând /
  // anunță-mă”. Căutarea/rezervarea (lib/fly, /api/fly/*) rămân în cod dar
  // sunt închise până există un furnizor contractat (ex. Duffel) + avizul juridic.
  flyBooking: flag('FEATURE_FLY_BOOKING', false),
} as const;

export type FeatureName = keyof typeof FEATURES;

export function frozenResponse(feature: FeatureName) {
  return new Response(
    JSON.stringify({
      ok: false,
      error: 'feature_frozen',
      feature,
      message: 'Acest modul este temporar dezactivat pentru MVP.',
    }),
    { status: 410, headers: { 'content-type': 'application/json' } }
  );
}

export function isEnabled(feature: FeatureName): boolean {
  return FEATURES[feature];
}
