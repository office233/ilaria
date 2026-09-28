/**
 * Cloudflare Realtime — configurare din env, într-un singur loc.
 *
 *  - SFU (Live shopping, 1 → mulți): CF_REALTIME_APP_ID + CF_REALTIME_APP_TOKEN
 *    (App Secret-ul SFU; doar pe server, browserul vorbește cu API-ul nostru).
 *  - TURN (opțional, recomandat): CF_TURN_KEY_ID + CF_TURN_KEY_API_TOKEN → credențiale
 *    ICE de scurtă durată. Fără ele se folosește doar STUN-ul public Cloudflare.
 *  - RealtimeKit (apeluri Messenger): CF_REALTIMEKIT_ACCOUNT_ID, CF_REALTIMEKIT_APP_ID,
 *    CF_REALTIMEKIT_API_TOKEN (+ presetări video/audio). Webhook-urile sunt semnate
 *    RSA-SHA256; cheia publică vine din CF_REALTIMEKIT_WEBHOOK_PUBLIC_KEY sau e
 *    descărcată (și ținută în cache) de la URL-ul public documentat.
 *
 * Fără chei, `get*Config()` întoarce null și `require*Config()` aruncă
 * `RealtimeUnavailableError` — rutele răspund 503 onest.
 */

export class RealtimeUnavailableError extends Error {
  constructor(
    public readonly product: "sfu" | "rtk",
    public readonly missing: string[],
  ) {
    super(`Cloudflare Realtime (${product}) is not configured (missing: ${missing.join(", ")})`);
    this.name = "RealtimeUnavailableError";
  }
}

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function envOr(name: string, fallback: string): string {
  return env(name) || fallback;
}

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(env(name), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function missing(names: string[]): string[] {
  return names.filter((n) => !env(n));
}

// Valorile implicite sunt endpoint-urile publice documentate de Cloudflare;
// suprascrise din env pentru staging/mock.
const DEFAULTS = {
  sfuBaseUrl: "https://rtc.live.cloudflare.com/v1",
  apiBaseUrl: "https://api.cloudflare.com/client/v4",
  rtkWebhookKeyUrl: "https://api.realtime.cloudflare.com/.well-known/webhooks.json",
  stunUrl: "stun:stun.cloudflare.com:3478",
  presetVideo: "swypik_call_video",
  presetAudio: "swypik_call_audio",
} as const;

const SFU_VARS = ["CF_REALTIME_APP_ID", "CF_REALTIME_APP_TOKEN"];
const RTK_VARS = ["CF_REALTIMEKIT_ACCOUNT_ID", "CF_REALTIMEKIT_APP_ID", "CF_REALTIMEKIT_API_TOKEN"];

export type SfuConfig = { appId: string; appToken: string; baseUrl: string };
export type TurnConfig = { keyId: string; apiToken: string; ttlSeconds: number };
export type RtkConfig = {
  accountId: string;
  appId: string;
  apiToken: string;
  apiBaseUrl: string;
  presetVideo: string;
  presetAudio: string;
};

export function getSfuConfig(): SfuConfig | null {
  if (missing(SFU_VARS).length > 0) return null;
  return {
    appId: env("CF_REALTIME_APP_ID"),
    appToken: env("CF_REALTIME_APP_TOKEN"),
    baseUrl: envOr("CF_REALTIME_SFU_BASE_URL", DEFAULTS.sfuBaseUrl).replace(/\/+$/, ""),
  };
}

export function requireSfuConfig(): SfuConfig {
  const cfg = getSfuConfig();
  if (!cfg) throw new RealtimeUnavailableError("sfu", missing(SFU_VARS));
  return cfg;
}

export function getTurnConfig(): TurnConfig | null {
  const keyId = env("CF_TURN_KEY_ID");
  const apiToken = env("CF_TURN_KEY_API_TOKEN");
  if (!keyId || !apiToken) return null;
  return { keyId, apiToken, ttlSeconds: envInt("CF_TURN_CREDENTIAL_TTL", 4 * 3600) };
}

export function stunUrl(): string {
  return envOr("CF_REALTIME_STUN_URL", DEFAULTS.stunUrl);
}

export function getRtkConfig(): RtkConfig | null {
  if (missing(RTK_VARS).length > 0) return null;
  return {
    accountId: env("CF_REALTIMEKIT_ACCOUNT_ID"),
    appId: env("CF_REALTIMEKIT_APP_ID"),
    apiToken: env("CF_REALTIMEKIT_API_TOKEN"),
    apiBaseUrl: envOr("CF_API_BASE_URL", DEFAULTS.apiBaseUrl).replace(/\/+$/, ""),
    presetVideo: envOr("CF_REALTIMEKIT_PRESET_VIDEO", DEFAULTS.presetVideo),
    presetAudio: envOr("CF_REALTIMEKIT_PRESET_AUDIO", DEFAULTS.presetAudio),
  };
}

export function requireRtkConfig(): RtkConfig {
  const cfg = getRtkConfig();
  if (!cfg) throw new RealtimeUnavailableError("rtk", missing(RTK_VARS));
  return cfg;
}

export function isSfuConfigured(): boolean {
  return getSfuConfig() !== null;
}

export function isRtkConfigured(): boolean {
  return getRtkConfig() !== null;
}

/** Cheia publică PEM a webhook-urilor RealtimeKit, dacă e fixată în env. */
export function rtkWebhookPublicKeyFromEnv(): string | null {
  const raw = env("CF_REALTIMEKIT_WEBHOOK_PUBLIC_KEY");
  return raw ? raw.replace(/\\n/g, "\n") : null;
}

export function rtkWebhookKeyUrl(): string {
  return envOr("CF_REALTIMEKIT_WEBHOOK_KEY_URL", DEFAULTS.rtkWebhookKeyUrl);
}

/** Timeout-ul apelurilor HTTP către Cloudflare (ms). */
export function realtimeHttpTimeoutMs(): number {
  return envInt("CF_REALTIME_HTTP_TIMEOUT_MS", 10_000);
}
