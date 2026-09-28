/**
 * Limitele redării video (feed, Movies, trailer) — un singur loc pentru
 * bufferele hls.js, preîncărcare și dimensiunile posterelor.
 */
export const VIDEO_PLAYBACK = {
  /** Câte clipuri după cel activ primesc preîncărcare (manifest / poster). */
  preloadAhead: 2,
  /** Câți vecini (±) ai clipului activ țin un player atașat la media. */
  attachRadius: 1,
  /** Fracția vizibilă de la care un slide devine activ (și de sub care intră în pauză). */
  visibleThreshold: 0.6,
  /** Estimare inițială de bandă (biți/s): pornim de la o redare mică și urcăm prin ABR. */
  initialBandwidthBps: 500_000,
  /** Buffer pentru clipul care rulează (secunde / octeți). */
  activeBuffer: { maxBufferLength: 14, maxMaxBufferLength: 30, backBufferLength: 10, maxBufferSize: 30 * 1000 * 1000 },
  /**
   * Buffer pentru un vecin preîncărcat: doar primul segment, cât să pornească instant.
   * backBuffer egal cu cel activ: clipul anterior (swipe înapoi) își păstrează începutul.
   */
  preloadBuffer: { maxBufferLength: 2, maxMaxBufferLength: 4, backBufferLength: 10, maxBufferSize: 4 * 1000 * 1000 },
  /** Încercări de recuperare hls.js înainte de MP4-ul de rezervă. */
  maxNetworkRecoveries: 2,
  maxMediaRecoveries: 2,
  /** Lățimi (px) în care rotunjim posterele → hit-uri de cache pe CDN. */
  posterWidths: [360, 480, 640, 750, 828, 1080, 1280, 1920] as const,
  /** Lățimea implicită când viewportul nu e cunoscut (SSR). */
  defaultPosterWidth: 828,
  /** Calitatea posterelor transformate (Cloudflare Image Transformations). */
  posterQuality: 70,
  /** effectiveType-uri considerate „rețea lentă” → fără preîncărcare. */
  slowEffectiveTypes: ["slow-2g", "2g"] as const,
} as const;
