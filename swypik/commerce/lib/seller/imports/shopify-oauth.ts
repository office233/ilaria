import crypto from "node:crypto";
import { APP_URL } from "@/lib/app-url";
import { dbQuery, withAdvisoryLock } from "@/lib/db";
import { intEnv } from "@/lib/config/env";
import { safeFetch } from "@/lib/security/ssrf";
import { normalizeShopifyStore } from "./shopify-domain";
import {
  getCatalogConnection,
  replaceCatalogCredentials,
} from "./connections";
import { CatalogProviderError } from "./common";
import type { ShopifyCredentials } from "./types";

const STATE_TTL_MINUTES = 10;
const REFRESH_SKEW_MS = 5 * 60_000;

type ShopifyOAuthTokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
  scope?: unknown;
};

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function shopifyClientId(): string {
  return (process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY || "").trim();
}

export function shopifyClientSecret(): string {
  return (
    process.env.SHOPIFY_CLIENT_SECRET ||
    process.env.SHOPIFY_API_SECRET ||
    process.env.SHOPIFY_WEBHOOK_SECRET ||
    ""
  ).trim();
}

export function shopifyOAuthScopes(): string[] {
  const raw = process.env.SHOPIFY_OAUTH_SCOPES || "";
  return [...new Set(
    raw
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  )];
}

export function shopifyOAuthCallbackUrl(): string {
  return `${APP_URL}/api/seller/integrations/shopify/callback`;
}

export function isShopifyOAuthConfigured(): boolean {
  return Boolean(shopifyClientId() && shopifyClientSecret() && shopifyOAuthScopes().length > 0);
}

export async function createShopifyOAuthState(
  sellerId: string,
  shopInput: string,
): Promise<{ shop: string; state: string; authorizationUrl: string }> {
  const clientId = shopifyClientId();
  const scopes = shopifyOAuthScopes();
  if (!clientId || !shopifyClientSecret() || scopes.length === 0) {
    throw new CatalogProviderError("shopify_oauth_not_configured", 503);
  }

  const shop = normalizeShopifyStore(shopInput);
  const state = crypto.randomBytes(32).toString("base64url");
  const stateHash = sha256(state);

  await dbQuery(
    `DELETE FROM seller_shopify_oauth_states
      WHERE seller_id = $1
        AND (expires_at <= now() OR shop = $2)`,
    [sellerId, shop],
  );
  await dbQuery(
    `INSERT INTO seller_shopify_oauth_states
       (seller_id, shop, state_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4::int * interval '1 minute'))`,
    [sellerId, shop, stateHash, STATE_TTL_MINUTES],
  );

  const authorizationUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("scope", scopes.join(","));
  authorizationUrl.searchParams.set("redirect_uri", shopifyOAuthCallbackUrl());
  authorizationUrl.searchParams.set("state", state);

  return { shop, state, authorizationUrl: authorizationUrl.toString() };
}

// Leagă callback-ul de browserul care a pornit fluxul: fără el, un seller
// putea trimite URL-ul de autorizare (cu state-ul lui) adminului altui magazin
// și primea magazinul acela conectat la contul propriu. Cookie-ul de seller e
// SameSite=Strict și nu ajunge la redirect-ul cross-site de la Shopify, deci
// folosim un cookie separat, Lax, limitat la rutele OAuth Shopify.
export const SHOPIFY_OAUTH_BROWSER_COOKIE = "swypik_shopify_oauth";
const SHOPIFY_OAUTH_COOKIE_PATH = "/api/seller/integrations/shopify";

export function shopifyOAuthBrowserCookie(state: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SHOPIFY_OAUTH_BROWSER_COOKIE}=${state}; Path=${SHOPIFY_OAUTH_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_MINUTES * 60}${secure}`;
}

export function clearShopifyOAuthBrowserCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SHOPIFY_OAUTH_BROWSER_COOKIE}=; Path=${SHOPIFY_OAUTH_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function shopifyOAuthBrowserMatches(
  state: string,
  cookieValue: string | null | undefined,
): boolean {
  if (!state || !cookieValue) return false;
  const a = Buffer.from(sha256(state));
  const b = Buffer.from(sha256(cookieValue));
  return crypto.timingSafeEqual(a, b);
}

export async function consumeShopifyOAuthState(
  shopInput: string,
  state: string,
): Promise<{ sellerId: string; shop: string } | null> {
  if (!state || state.length < 32 || state.length > 256) return null;
  const shop = normalizeShopifyStore(shopInput);
  const { rows } = await dbQuery<{ seller_id: string; shop: string }>(
    `DELETE FROM seller_shopify_oauth_states
      WHERE state_hash = $1
        AND shop = $2
        AND expires_at > now()
      RETURNING seller_id, shop`,
    [sha256(state), shop],
  );
  const row = rows[0];
  return row ? { sellerId: row.seller_id, shop: row.shop } : null;
}

export async function cleanupExpiredShopifyOAuthStates(): Promise<number> {
  const { rowCount } = await dbQuery(
    `DELETE FROM seller_shopify_oauth_states WHERE expires_at <= now()`,
  );
  return rowCount ?? 0;
}

export function verifyShopifyOAuthHmac(url: URL): boolean {
  const provided = url.searchParams.get("hmac");
  const secret = shopifyClientSecret();
  if (!provided || !secret) return false;

  const entries = [...url.searchParams.entries()]
    .filter(([key]) => key !== "hmac")
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const message = entries.map(([key, value]) => `${key}=${value}`).join("&");
  const expected = crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function numberField(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function credentialsFromTokenResponse(
  payload: ShopifyOAuthTokenResponse,
  now = Date.now(),
): ShopifyCredentials {
  const accessToken =
    typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  const refreshToken =
    typeof payload.refresh_token === "string" ? payload.refresh_token.trim() : "";
  if (!accessToken) throw new CatalogProviderError("shopify_oauth_token_invalid", 502);

  const expiresIn = numberField(payload.expires_in);
  const refreshExpiresIn = numberField(payload.refresh_token_expires_in);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn > 0
      ? { accessTokenExpiresAt: new Date(now + expiresIn * 1000).toISOString() }
      : {}),
    ...(refreshExpiresIn > 0
      ? { refreshTokenExpiresAt: new Date(now + refreshExpiresIn * 1000).toISOString() }
      : {}),
    ...(typeof payload.scope === "string" && payload.scope.trim()
      ? { scope: payload.scope.trim() }
      : {}),
  };
}

async function tokenRequest(
  shop: string,
  body: URLSearchParams,
): Promise<ShopifyCredentials> {
  const response = await safeFetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(
      intEnv("SHOPIFY_OAUTH_HTTP_TIMEOUT_MS", 20_000, 1_000, 60_000),
    ),
  });
  const text = await response.text();
  const payload = (() => {
    try {
      return JSON.parse(text) as ShopifyOAuthTokenResponse;
    } catch {
      return null;
    }
  })();

  if (!response.ok || !payload) {
    if (response.status === 401) {
      throw new CatalogProviderError("shopify_reauthorization_required", 401);
    }
    throw new CatalogProviderError("shopify_oauth_token_exchange_failed", 502);
  }
  return credentialsFromTokenResponse(payload);
}

export async function exchangeShopifyOAuthCode(
  shopInput: string,
  code: string,
): Promise<ShopifyCredentials> {
  const clientId = shopifyClientId();
  const clientSecret = shopifyClientSecret();
  if (!clientId || !clientSecret) {
    throw new CatalogProviderError("shopify_oauth_not_configured", 503);
  }
  const shop = normalizeShopifyStore(shopInput);
  return tokenRequest(
    shop,
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      expiring: "1",
    }),
  );
}

export async function ensureFreshShopifyCredentials(args: {
  sellerId?: string;
  integrationId?: string;
  shop: string;
  credentials: ShopifyCredentials;
}): Promise<ShopifyCredentials> {
  const shop = normalizeShopifyStore(args.shop);
  const needsRefresh = (credentials: ShopifyCredentials): boolean => {
    const expiresAt = credentials.accessTokenExpiresAt
      ? Date.parse(credentials.accessTokenExpiresAt)
      : Number.NaN;
    // Legacy/manual tokens without expiry metadata remain supported.
    return Number.isFinite(expiresAt) && expiresAt - Date.now() <= REFRESH_SKEW_MS;
  };

  const refresh = async (
    credentials: ShopifyCredentials,
    persist: boolean,
  ): Promise<ShopifyCredentials> => {
    if (!needsRefresh(credentials)) return credentials;
    const refreshToken = credentials.refreshToken;
    if (!refreshToken) {
      throw new CatalogProviderError("shopify_reauthorization_required", 401);
    }
    const refreshExpiresAt = credentials.refreshTokenExpiresAt
      ? Date.parse(credentials.refreshTokenExpiresAt)
      : Number.NaN;
    if (Number.isFinite(refreshExpiresAt) && refreshExpiresAt <= Date.now()) {
      throw new CatalogProviderError("shopify_reauthorization_required", 401);
    }
    const clientId = shopifyClientId();
    const clientSecret = shopifyClientSecret();
    if (!clientId || !clientSecret) {
      throw new CatalogProviderError("shopify_oauth_not_configured", 503);
    }
    const refreshed = await tokenRequest(
      shop,
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    );
    if (persist && args.sellerId && args.integrationId) {
      await replaceCatalogCredentials({
        sellerId: args.sellerId,
        integrationId: args.integrationId,
        provider: "shopify",
        externalAccountId: shop,
        credentials: refreshed,
      });
    }
    return refreshed;
  };

  if (!needsRefresh(args.credentials)) return args.credentials;
  if (!args.sellerId || !args.integrationId) {
    return refresh(args.credentials, false);
  }

  return withAdvisoryLock(`shopify-token-refresh:${args.integrationId}`, async () => {
    const latest = await getCatalogConnection(args.sellerId!, args.integrationId!);
    if (!latest || latest.provider !== "shopify") {
      throw new CatalogProviderError("shopify_reauthorization_required", 401);
    }
    return refresh(latest.credentials as ShopifyCredentials, true);
  });
}
