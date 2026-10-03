/**
 * Distributed Rate Limiter — Upstash Redis
 * 
 * Provides serverless-safe rate limiting across all Vercel instances.
 * Falls back to in-memory limiting if Redis is not configured (dev mode).
 * 
 * Usage:
 *   const { success, remaining } = await rateLimit("cart", ip, { limit: 10, window: 60 });
 *   if (!success) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
 */

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { getRedis as getLocalRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";

// ── Redis client (lazy init) ────────────────────────────────────────
let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

// ── Pre-built rate limiters ─────────────────────────────────────────
const limiters = new Map<string, Ratelimit>();
let warnedAboutMemoryFallback = false;
let warnedAboutLocalRedisError = false;

function getLimiter(prefix: string, limit: number, windowSeconds: number): Ratelimit | null {
  const r = getRedis();
  if (!r) return null;

  const key = `${prefix}:${limit}:${windowSeconds}`;
  if (limiters.has(key)) return limiters.get(key)!;

  const limiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
    prefix: `rl:${prefix}`,
    analytics: true,
  });
  limiters.set(key, limiter);
  return limiter;
}

// ── In-memory fallback for dev/missing Redis ────────────────────────
const memoryStore = new Map<string, { count: number; resetAt: number }>();

async function localRedisRateLimit(identifier: string, limit: number, windowSeconds: number): Promise<{ success: boolean; remaining: number } | null> {
  if (!process.env.REDIS_URL) return null;
  try {
    const redis = getLocalRedis();
    const key = `rl:local:${identifier}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    if (count > limit) {
      const ttl = await redis.ttl(key);
      if (ttl < 0) await redis.expire(key, windowSeconds);
      return { success: false, remaining: 0 };
    }
    return { success: true, remaining: Math.max(0, limit - count) };
  } catch (e) {
    if (process.env.NODE_ENV === "production" && !warnedAboutLocalRedisError) {
      warnedAboutLocalRedisError = true;
      logger.warn({ err: e }, "[RateLimit] Local Redis error");
    }
    return null;
  }
}

function memoryRateLimit(identifier: string, limit: number, windowSeconds: number): { success: boolean; remaining: number } {
  const now = Date.now();
  const entry = memoryStore.get(identifier);

  if (!entry || now > entry.resetAt) {
    memoryStore.set(identifier, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { success: true, remaining: limit - 1 };
  }

  entry.count++;
  if (entry.count > limit) {
    return { success: false, remaining: 0 };
  }
  return { success: true, remaining: limit - entry.count };
}

// Cleanup stale entries periodically (every 60s). Store-ul în memorie e doar
// pentru dev: în producție fără Redis limitarea „fails closed” (vezi rateLimit),
// fiindcă un contor per-replică ar înmulți limita cu numărul de replici.
// `unref` — timerul nu ține procesul (scripturi, teste) în viață.
if (typeof setInterval !== "undefined") {
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryStore) {
      if (now > entry.resetAt) memoryStore.delete(key);
    }
  }, 60_000);
  (sweep as { unref?: () => void }).unref?.();
}

// ── Public API ──────────────────────────────────────────────────────

export type RateLimitConfig = {
  /** Max requests in window */
  limit: number;
  /** Window in seconds */
  window: number;
};

/** Default rate limits per route category */
export const RATE_LIMITS = {
  cart: { limit: 10, window: 60 } as RateLimitConfig,         // 10 checkouts/min
  chat: { limit: 30, window: 60 } as RateLimitConfig,         // 30 messages/min
  products: { limit: 60, window: 60 } as RateLimitConfig,     // 60 reads/min
  suggest: { limit: 40, window: 60 } as RateLimitConfig,      // 40 autocomplete/min
  videoLike: { limit: 30, window: 60 } as RateLimitConfig,    // 30 likes/min
  videoSave: { limit: 20, window: 60 } as RateLimitConfig,    // 20 saves/min
  videoComment: { limit: 10, window: 60 } as RateLimitConfig, // 10 comments/min
  videoShare: { limit: 20, window: 60 } as RateLimitConfig,   // 20 shares/min
  videoView: { limit: 60, window: 60 } as RateLimitConfig,    // 60 views/min/IP
  videoQuicksave: { limit: 30, window: 60 } as RateLimitConfig,
  videoFeedback: { limit: 20, window: 60 } as RateLimitConfig,
  videoCaptions: { limit: 10, window: 60 } as RateLimitConfig,
  videoVote: { limit: 30, window: 60 } as RateLimitConfig,    // product-vote
  videoEvent: { limit: 60, window: 60 } as RateLimitConfig,   // analytic events
  videoHidden: { limit: 30, window: 60 } as RateLimitConfig,
  commentLike: { limit: 30, window: 60 } as RateLimitConfig,
  productLike: { limit: 30, window: 60 } as RateLimitConfig,  // separat de videoLike — actiuni diferite nu se mai limiteaza reciproc
  productShare: { limit: 20, window: 60 } as RateLimitConfig,
  dmMessage: { limit: 20, window: 60 } as RateLimitConfig,
  dmConversation: { limit: 10, window: 60 } as RateLimitConfig,// new convo
  dmRead: { limit: 30, window: 60 } as RateLimitConfig,
  cartItems: { limit: 30, window: 60 } as RateLimitConfig,
  cartMerge: { limit: 10, window: 60 } as RateLimitConfig,
  applySeller: { limit: 3, window: 600 } as RateLimitConfig,
  missionsClaim: { limit: 10, window: 60 } as RateLimitConfig, // reward farming guard
  walletClaim: { limit: 5, window: 60 } as RateLimitConfig,
  onboarding: { limit: 10, window: 60 } as RateLimitConfig,
  referral: { limit: 10, window: 60 } as RateLimitConfig,
  notifications: { limit: 30, window: 60 } as RateLimitConfig,
  i18n: { limit: 30, window: 60 } as RateLimitConfig,
  visualSearch: { limit: 5, window: 60 } as RateLimitConfig,   // expensive AI
  orderReturn: { limit: 3, window: 60 } as RateLimitConfig,
  orderReturnPhotos: { limit: 5, window: 60 } as RateLimitConfig,
  stripeOnboarding: { limit: 5, window: 600 } as RateLimitConfig,
  stripeLoginLink: { limit: 10, window: 60 } as RateLimitConfig,
  // Export GDPR: 14 interogări pe cont, deci scump. 3 la 10 minute e generos
  // pentru un drept pe care un om îl exercită de câteva ori în viață, dar
  // suficient de strâns cât să nu poată fi folosit ca amplificator pe DB.
  accountExport: { limit: 3, window: 600 } as RateLimitConfig,
  // ── Added 2026-05-26: rate-limit hardening pass ────────────────────
  oauthCallback: { limit: 10, window: 60 } as RateLimitConfig,        // OAuth code exchange (Apple/Google)
  twoFactor: { limit: 5, window: 60 } as RateLimitConfig,             // 2FA enable/disable/regen (brute-force guard)
  notifPrefs: { limit: 20, window: 60 } as RateLimitConfig,           // notification preferences PATCH
  userAddresses: { limit: 20, window: 60 } as RateLimitConfig,        // CRUD on shipping addresses
  pushSubscribe: { limit: 10, window: 60 } as RateLimitConfig,        // web-push subscribe/unsubscribe
  productReviews: { limit: 5, window: 300 } as RateLimitConfig,       // 5 reviews / 5min (spam guard)
  productReviewEdit: { limit: 10, window: 60 } as RateLimitConfig,    // edit/delete own review
  feedAction: { limit: 60, window: 60 } as RateLimitConfig,           // for-you tuning signals
  postVote: { limit: 30, window: 60 } as RateLimitConfig,             // Arena votes (reward farm guard)
  socialEvents: { limit: 120, window: 60 } as RateLimitConfig,        // /v1/events ingest (per IP)
  collections: { limit: 30, window: 60 } as RateLimitConfig,          // user collections CRUD
  collectionItems: { limit: 60, window: 60 } as RateLimitConfig,      // add/remove items from collection
  adultOptIn: { limit: 5, window: 60 } as RateLimitConfig,            // age opt-in toggle
  livePoll: { limit: 5, window: 60 } as RateLimitConfig,              // creator publishing live polls
  creatorVideoEdit: { limit: 30, window: 60 } as RateLimitConfig,     // creator PATCH/DELETE own videos
  uploadSession: { limit: 10, window: 60 } as RateLimitConfig,        // upload session create/complete
  uploadParts: { limit: 120, window: 60 } as RateLimitConfig,         // multipart: semnare/listare părți, status
  challengeEnter: { limit: 5, window: 60 } as RateLimitConfig,        // challenge entries
  sellerOrders: { limit: 30, window: 60 } as RateLimitConfig,         // seller orders mutate (tracking, refund, etc.)
  sellerReturns: { limit: 10, window: 60 } as RateLimitConfig,        // accept/reject return
  sellerProducts: { limit: 20, window: 60 } as RateLimitConfig,       // seller create products
  sellerProductEdit: { limit: 60, window: 60 } as RateLimitConfig,    // seller edit/archive products (stock, price, variants)
  sellerIntegrations: { limit: 10, window: 600 } as RateLimitConfig,  // connect/update external commerce stores
  sellerCatalogImport: { limit: 30, window: 60 } as RateLimitConfig,  // paged Shopify/Woo catalog sync
  sellerCrmImport: { limit: 30, window: 60 } as RateLimitConfig,      // paged external customer sync
  sellerOrderImport: { limit: 30, window: 60 } as RateLimitConfig,    // paged historical order sync
  sellerPayout: { limit: 3, window: 600 } as RateLimitConfig,         // seller payout request
  postsCreate: { limit: 5, window: 60 } as RateLimitConfig,           // Arena post create
  unsubscribe: { limit: 10, window: 60 } as RateLimitConfig,          // RFC 8058 one-click + landing
  liveStreams: { limit: 5, window: 60 } as RateLimitConfig,           // create stream
  liveStreamEdit: { limit: 30, window: 60 } as RateLimitConfig,       // stream PATCH + pin + items
  cartClear: { limit: 10, window: 60 } as RateLimitConfig,            // DELETE /api/cart
  oauthUnlink: { limit: 5, window: 600 } as RateLimitConfig,          // unlink OAuth provider
  productSave: { limit: 30, window: 60 } as RateLimitConfig,          // save/unsave product
  videoTranscribe: { limit: 5, window: 60 } as RateLimitConfig,       // expensive AI
  userFollow: { limit: 30, window: 60 } as RateLimitConfig,           // follow/unfollow
  stripeConnect: { limit: 5, window: 600 } as RateLimitConfig,        // Stripe Connect onboarding
  creatorApply: { limit: 3, window: 3600 } as RateLimitConfig,        // creator application
  notifMarkRead: { limit: 60, window: 60 } as RateLimitConfig,        // mark notifications read
  sellerRefund: { limit: 5, window: 60 } as RateLimitConfig,          // Stripe refund (sensitive)
  onboardingComplete: { limit: 5, window: 60 } as RateLimitConfig,    // POST onboarding/complete
  referralGet: { limit: 30, window: 60 } as RateLimitConfig,          // referral code GET/POST
  reviewHelpful: { limit: 30, window: 60 } as RateLimitConfig,        // toggle helpful
  ageVerifyStart: { limit: 3, window: 600 } as RateLimitConfig,       // Stripe Identity (expensive)
  inquiries: { limit: 5, window: 300 } as RateLimitConfig,            // listing contact form (per IP, anti-spam)
  courierApply: { limit: 3, window: 3600 } as RateLimitConfig,        // courier onboarding (per IP)
  courierStatus: { limit: 120, window: 60 } as RateLimitConfig,       // GPS ping ~10s while online
  localOrders: { limit: 10, window: 300 } as RateLimitConfig,         // food orders per user
  stayBookings: { limit: 5, window: 600 } as RateLimitConfig,         // booking attempts
  donations: { limit: 10, window: 600 } as RateLimitConfig,           // Swypik Cares (per IP)
  rideEstimate: { limit: 60, window: 60 } as RateLimitConfig,         // estimare tarif Go (re-estimări la drag pe hartă)
  rideCreate: { limit: 10, window: 300 } as RateLimitConfig,          // creare curse per user
  rideAction: { limit: 60, window: 60 } as RateLimitConfig,           // tranziții status / rating / anulare
  geoSearch: { limit: 30, window: 60 } as RateLimitConfig,           // proxy Nominatim (search + reverse, per IP)
  // Panoul seller (2026-09-21): rutele noi n-aveau nicio limită, iar "sellerAwb"
  // era referit fără să existe aici.
  sellerAwb: { limit: 20, window: 60 } as RateLimitConfig,
  sellerInvoices: { limit: 20, window: 60 } as RateLimitConfig,
  sellerMenu: { limit: 30, window: 60 } as RateLimitConfig,           // merchant menu create/update/delete
  sellerClients: { limit: 20, window: 60 } as RateLimitConfig,
  sellerAds: { limit: 10, window: 60 } as RateLimitConfig,
  sellerPos: { limit: 60, window: 60 } as RateLimitConfig,
  sellerNode: { limit: 12, window: 60 } as RateLimitConfig,   // heartbeat la 15s → 4/min + marjă
  // 2026-09-24 (audit): /api/explore/feed e o interogare grea (CTE-uri +
  // LATERAL joins pe fiecare candidat) fara nicio limita anterior.
  exploreFeed: { limit: 120, window: 60 } as RateLimitConfig,
  // Swypik Movies
  moviesCatalog: { limit: 60, window: 60 } as RateLimitConfig,
  moviesUnlock: { limit: 10, window: 60 } as RateLimitConfig,
  moviesProgress: { limit: 60, window: 60 } as RateLimitConfig,
  moviesStream: { limit: 600, window: 60 } as RateLimitConfig,  // segmente HLS: ~1 req/2s + marjă
  moviesPublish: { limit: 5, window: 3600 } as RateLimitConfig,
  moviesIngest: { limit: 60, window: 3600 } as RateLimitConfig,  // admin: ingest titluri licențiate (seed Open Cinema ≈ 15)
  musicCatalog: { limit: 60, window: 60 } as RateLimitConfig,
  musicPlay: { limit: 60, window: 60 } as RateLimitConfig,
  musicPlays: { limit: 120, window: 60 } as RateLimitConfig,
  musicUnlock: { limit: 10, window: 60 } as RateLimitConfig,
  musicTip: { limit: 10, window: 60 } as RateLimitConfig,
  musicPlaylist: { limit: 60, window: 60 } as RateLimitConfig,
  musicPublish: { limit: 10, window: 3600 } as RateLimitConfig,
  musicStream: { limit: 300, window: 60 } as RateLimitConfig,
  // Swypik News — pipeline run is expensive (Azure OpenAI calls), reactions/comments are cheap CRUD.
  newsPipeline: { limit: 3, window: 60 } as RateLimitConfig,
  newsReaction: { limit: 30, window: 60 } as RateLimitConfig,
  newsComment: { limit: 10, window: 60 } as RateLimitConfig,
  newsCommentDelete: { limit: 20, window: 60 } as RateLimitConfig,
} as const;

/**
 * Rate limit a request.
 * 
 * @param prefix - Route category (e.g. "cart", "chat")
 * @param identifier - Usually IP address or session ID
 * @param config - { limit, window } override (optional, defaults to RATE_LIMITS[prefix])
 * @returns { success, remaining }
 */
export async function rateLimit(
  prefix: keyof typeof RATE_LIMITS | string,
  identifier: string,
  config?: RateLimitConfig
): Promise<{ success: boolean; remaining: number }> {
  const cfg = config || RATE_LIMITS[prefix as keyof typeof RATE_LIMITS] || { limit: 30, window: 60 };
  const fullIdentifier = `${prefix}:${identifier}`;

  // Try distributed (Upstash Redis)
  const limiter = getLimiter(prefix, cfg.limit, cfg.window);
  if (limiter) {
    try {
      const result = await limiter.limit(fullIdentifier);
      return { success: result.success, remaining: result.remaining };
    } catch (e) {
      logger.warn({ err: e }, "[RateLimit] Upstash error");
    }
  }

  const localRedisResult = await localRedisRateLimit(fullIdentifier, cfg.limit, cfg.window);
  if (localRedisResult) return localRedisResult;

  if (process.env.NODE_ENV === "production" && process.env.RATE_LIMIT_REDIS_REQUIRED !== "false") {
    logger.error("[RateLimit] Redis is required in production! Failing closed.");
    return { success: false, remaining: 0 };
  }

  if (process.env.NODE_ENV === "production" && !warnedAboutMemoryFallback) {
    warnedAboutMemoryFallback = true;
    logger.warn("[RateLimit] Upstash Redis is not configured; using in-memory limits for this Node process.");
  }

  // Fallback: in-memory (works in dev and single-node Hetzner deployments)
  return memoryRateLimit(fullIdentifier, cfg.limit, cfg.window);
}

/**
 * Extract client IP from request headers.
 *
 * PREMISA DE SECURITATE: ingress-ul suprascrie `X-Real-IP` cu adresa reală a
 * conexiunii, deci valoarea trimisă de client e înlocuită, nu păstrată.
 *
 * ATENȚIE — GARANTUL S-A SCHIMBAT (actualizat 2026-08-17):
 *   Comentariul anterior spunea că garantul e Caddy. Caddy NU mai rulează
 *   (`profiles: [disabled]` în docker-compose.prod.yml). Ingress-ul de azi e
 *   `cloudflared` (proces de sistem, tunel → 127.0.0.1:3005), care setează el
 *   însuși `X-Real-IP` — comportament implicit, nu configurat: config.yml n-are
 *   nicio directivă de headere.
 *
 *   Verificat empiric 2026-08-17: două cereri prin tunel către o rută
 *   rate-limitată, cu `X-Real-IP` falsificat diferit (203.0.113.7 și
 *   198.51.100.9), au produs în Redis o SINGURĂ cheie —
 *   `rl:local:geoSearch:<IP real>`. Spoofing-ul nu trece.
 *
 *   ORICE SCHIMBARE DE INGRESS (nginx, expunere directă, alt tunel) TREBUIE SĂ
 *   PĂSTREZE ACEASTĂ GARANȚIE. Altfel rate-limit-ul devine ocolibil de oricine
 *   trimite un `X-Real-IP` fals, fără ca nimic să semnaleze regresia.
 *
 * CF-Connecting-IP e ignorat deliberat: traficul de producție nu trece prin
 * Cloudflare ca reverse-proxy HTTP care să-l valideze, deci ar fi un header
 * pe care oricine ajunge la origine îl poate inventa (bypass închis 2026-05-20).
 * X-Forwarded-For e doar fallback pentru dev / apeluri directe; luăm ULTIMUL
 * hop (cel mai apropiat de proxy-ul nostru), niciodată primul — pe acela un
 * client remote îl poate prefixa.
 */
export function getClientIP(req: Request): string {
  return getClientIPFromHeaders(req.headers);
}

/** Aceeași regulă ca getClientIP, pentru contexte fără Request (ex. `headers()` din next/headers). */
export function getClientIPFromHeaders(headers: Pick<Headers, "get">): string {
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return "unknown";
}
