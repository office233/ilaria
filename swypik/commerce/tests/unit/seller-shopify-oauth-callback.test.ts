import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  verifyHmac: vi.fn(),
  consumeState: vi.fn(),
  exchangeCode: vi.fn(),
  scopes: vi.fn(),
  upsert: vi.fn(),
  fetchCatalogPage: vi.fn(),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  getClientIP: () => "203.0.113.10",
  rateLimit: h.rateLimit,
}));
vi.mock("@/lib/seller/imports/shopify-oauth", () => ({
  verifyShopifyOAuthHmac: h.verifyHmac,
  consumeShopifyOAuthState: h.consumeState,
  exchangeShopifyOAuthCode: h.exchangeCode,
  shopifyOAuthScopes: h.scopes,
  SHOPIFY_OAUTH_BROWSER_COOKIE: "swypik_shopify_oauth",
  shopifyOAuthBrowserMatches: (state: string, cookie: string | null) => !!cookie && cookie === state,
  clearShopifyOAuthBrowserCookie: () => "swypik_shopify_oauth=; Max-Age=0",
}));
vi.mock("@/lib/seller/imports/connections", () => ({
  upsertCatalogConnection: h.upsert,
}));
vi.mock("@/lib/seller/imports/provider", () => ({
  fetchCatalogPage: h.fetchCatalogPage,
}));

import { GET } from "@/app/api/seller/integrations/shopify/callback/route";

function callback(query: string, cookie: string | null = "swypik_shopify_oauth=state-1"): Request {
  return new Request(
    "https://swypik.com/api/seller/integrations/shopify/callback" + query,
    cookie ? { headers: { cookie } } : undefined,
  );
}

beforeEach(() => {
  h.rateLimit.mockReset().mockResolvedValue({ success: true });
  h.verifyHmac.mockReset().mockReturnValue(true);
  h.consumeState.mockReset().mockResolvedValue({
    sellerId: "22222222-2222-4222-8222-222222222222",
    shop: "store.myshopify.com",
  });
  h.exchangeCode.mockReset().mockResolvedValue({
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: "2026-09-29T22:00:00Z",
    refreshTokenExpiresAt: "2026-12-28T22:00:00Z",
    scope: "read_products,read_customers,read_orders",
  });
  h.scopes.mockReset().mockReturnValue([
    "read_products",
    "read_customers",
    "read_orders",
  ]);
  h.fetchCatalogPage.mockReset().mockResolvedValue({
    products: [],
    nextCursor: null,
    storeCurrency: "EUR",
  });
  h.upsert.mockReset().mockResolvedValue({ id: "integration-1" });
});

describe("Shopify OAuth callback", () => {
  it("binds the connected shop to the seller stored in one-time state", async () => {
    const res = await GET(callback("?shop=store.myshopify.com&state=state-1&code=code-1&hmac=valid"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://swypik.com/seller?shopify=connected",
    );
    expect(h.consumeState).toHaveBeenCalledWith("store.myshopify.com", "state-1");
    expect(h.exchangeCode).toHaveBeenCalledWith("store.myshopify.com", "code-1");
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({
      sellerId: "22222222-2222-4222-8222-222222222222",
      provider: "shopify",
      externalAccountId: "store.myshopify.com",
      config: expect.objectContaining({
        storeCurrency: "EUR",
        authMode: "oauth",
        bootstrapRequestedAt: expect.any(String),
      }),
    }));
  });

  it("rejects callbacks that fail Shopify HMAC validation before consuming state", async () => {
    h.verifyHmac.mockReturnValue(false);
    const res = await GET(callback("?shop=store.myshopify.com&state=state-1&code=code-1&hmac=bad"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("shopify=error");
    expect(res.headers.get("location")).toContain("code=invalid_hmac");
    expect(h.consumeState).not.toHaveBeenCalled();
  });

  it("rejects a callback completed in a browser that did not start the flow", async () => {
    // Atacatorul trimite URL-ul de autorizare (cu state-ul lui) adminului
    // altui magazin: browserul victimei nu are cookie-ul de legare.
    const res = await GET(callback(
      "?shop=victim.myshopify.com&state=state-1&code=code-1&hmac=valid",
      null,
    ));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("code=invalid_state");
    expect(h.consumeState).not.toHaveBeenCalled();
    expect(h.exchangeCode).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("rejects a binding cookie that belongs to a different state", async () => {
    const res = await GET(callback(
      "?shop=store.myshopify.com&state=state-1&code=code-1&hmac=valid",
      "swypik_shopify_oauth=state-2",
    ));
    expect(res.headers.get("location")).toContain("code=invalid_state");
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("refuses a token that did not receive every configured migration scope", async () => {
    h.exchangeCode.mockResolvedValue({
      accessToken: "access",
      scope: "read_products,read_orders",
    });
    const res = await GET(callback("?shop=store.myshopify.com&state=state-1&code=code-1&hmac=valid"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("code=missing_scopes");
    expect(h.upsert).not.toHaveBeenCalled();
  });
});
