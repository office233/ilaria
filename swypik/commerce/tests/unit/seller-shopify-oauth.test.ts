import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  withAdvisoryLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  safeFetch: vi.fn(),
  getCatalogConnection: vi.fn(),
  replaceCatalogCredentials: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  dbQuery: h.dbQuery,
  withAdvisoryLock: h.withAdvisoryLock,
}));
vi.mock("@/lib/security/ssrf", () => ({
  safeFetch: h.safeFetch,
}));
vi.mock("@/lib/seller/imports/connections", () => ({
  getCatalogConnection: h.getCatalogConnection,
  replaceCatalogCredentials: h.replaceCatalogCredentials,
}));

import {
  createShopifyOAuthState,
  ensureFreshShopifyCredentials,
  exchangeShopifyOAuthCode,
  shopifyOAuthBrowserCookie,
  shopifyOAuthBrowserMatches,
  shopifyOAuthCallbackUrl,
  verifyShopifyOAuthHmac,
} from "@/lib/seller/imports/shopify-oauth";

const ENV_KEYS = [
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_OAUTH_SCOPES",
] as const;
const OLD_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  h.dbQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
  h.safeFetch.mockReset();
  h.getCatalogConnection.mockReset();
  h.replaceCatalogCredentials.mockReset().mockResolvedValue(undefined);
  h.withAdvisoryLock.mockClear();
  process.env.SHOPIFY_CLIENT_ID = "client-id";
  process.env.SHOPIFY_CLIENT_SECRET = "client-secret";
  process.env.SHOPIFY_OAUTH_SCOPES = "read_products,read_customers,read_orders";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const old = OLD_ENV[key];
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
});

describe("seller Shopify OAuth", () => {
  it("creates one-time state bound to seller + shop and builds the standalone authorize URL", async () => {
    const result = await createShopifyOAuthState(
      "22222222-2222-4222-8222-222222222222",
      "Store.myshopify.com",
    );
    const url = new URL(result.authorizationUrl);
    expect(result.shop).toBe("store.myshopify.com");
    expect(url.origin).toBe("https://store.myshopify.com");
    expect(url.pathname).toBe("/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("scope")).toBe("read_products,read_customers,read_orders");
    expect(url.searchParams.get("redirect_uri")).toBe(shopifyOAuthCallbackUrl());
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(result.state.length).toBeGreaterThanOrEqual(40);
    expect(String(h.dbQuery.mock.calls[1][0])).toContain("seller_shopify_oauth_states");
    expect(h.dbQuery.mock.calls[1][1][0]).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("verifies Shopify callback HMAC exactly over sorted params without hmac", () => {
    const url = new URL(
      "https://swypik.com/api/seller/integrations/shopify/callback" +
        "?code=abc&shop=store.myshopify.com&state=nonce&timestamp=1790700000",
    );
    const message = [...url.searchParams.entries()]
      .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    const hmac = crypto
      .createHmac("sha256", "client-secret")
      .update(message)
      .digest("hex");
    url.searchParams.set("hmac", hmac);
    expect(verifyShopifyOAuthHmac(url)).toBe(true);
    url.searchParams.set("code", "tampered");
    expect(verifyShopifyOAuthHmac(url)).toBe(false);
  });

  it("exchanges the code for an expiring offline token and retains refresh metadata", async () => {
    h.safeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "shpat_access",
          expires_in: 3600,
          refresh_token: "shprt_refresh",
          refresh_token_expires_in: 7_776_000,
          scope: "read_products,read_customers,read_orders",
        }),
        { status: 200 },
      ),
    );
    const credentials = await exchangeShopifyOAuthCode("store.myshopify.com", "code-1");
    expect(credentials).toMatchObject({
      accessToken: "shpat_access",
      refreshToken: "shprt_refresh",
      scope: "read_products,read_customers,read_orders",
    });
    expect(Date.parse(credentials.accessTokenExpiresAt!)).toBeGreaterThan(Date.now());
    const init = h.safeFetch.mock.calls[0][1] as RequestInit;
    const body = init.body as URLSearchParams;
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("expiring")).toBe("1");
  });

  it("serializes refresh, reloads latest credentials and persists the rotated pair", async () => {
    const oldCredentials = {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      scope: "read_products,read_customers,read_orders",
    };
    h.getCatalogConnection.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      sellerId: "22222222-2222-4222-8222-222222222222",
      provider: "shopify",
      externalAccountId: "store.myshopify.com",
      credentials: oldCredentials,
    });
    h.safeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "new-access",
          expires_in: 3600,
          refresh_token: "new-refresh",
          refresh_token_expires_in: 7_776_000,
          scope: oldCredentials.scope,
        }),
        { status: 200 },
      ),
    );

    const refreshed = await ensureFreshShopifyCredentials({
      sellerId: "22222222-2222-4222-8222-222222222222",
      integrationId: "11111111-1111-4111-8111-111111111111",
      shop: "store.myshopify.com",
      credentials: oldCredentials,
    });

    expect(h.withAdvisoryLock).toHaveBeenCalledWith(
      "shopify-token-refresh:11111111-1111-4111-8111-111111111111",
      expect.any(Function),
    );
    expect(refreshed.accessToken).toBe("new-access");
    expect(refreshed.refreshToken).toBe("new-refresh");
    const init = h.safeFetch.mock.calls[0][1] as RequestInit;
    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh");
    expect(h.replaceCatalogCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "shopify",
        externalAccountId: "store.myshopify.com",
        credentials: expect.objectContaining({
          accessToken: "new-access",
          refreshToken: "new-refresh",
        }),
      }),
    );
  });
});

describe("Shopify OAuth browser binding", () => {
  it("matches only the exact state issued to this browser", () => {
    expect(shopifyOAuthBrowserMatches("state-abc", "state-abc")).toBe(true);
    expect(shopifyOAuthBrowserMatches("state-abc", "state-xyz")).toBe(false);
    expect(shopifyOAuthBrowserMatches("state-abc", null)).toBe(false);
    expect(shopifyOAuthBrowserMatches("", "")).toBe(false);
  });

  it("sets an HttpOnly Lax cookie scoped to the Shopify OAuth routes", () => {
    const cookie = shopifyOAuthBrowserCookie("state-abc");
    expect(cookie).toContain("swypik_shopify_oauth=state-abc");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/seller/integrations/shopify");
  });
});
