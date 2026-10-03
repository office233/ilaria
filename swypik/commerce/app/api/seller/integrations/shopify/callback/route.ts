import { NextResponse } from "next/server";
import { APP_URL } from "@/lib/app-url";
import { logger } from "@/lib/logger";
import { getClientIP, rateLimit } from "@/lib/security/rate-limit";
import {
  clearShopifyOAuthBrowserCookie,
  consumeShopifyOAuthState,
  SHOPIFY_OAUTH_BROWSER_COOKIE,
  shopifyOAuthBrowserMatches,
  exchangeShopifyOAuthCode,
  shopifyOAuthScopes,
  verifyShopifyOAuthHmac,
} from "@/lib/seller/imports/shopify-oauth";
import { upsertCatalogConnection } from "@/lib/seller/imports/connections";
import { fetchCatalogPage } from "@/lib/seller/imports/provider";
import { CatalogProviderError } from "@/lib/seller/imports/common";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function integrationsUrl(status: "connected" | "error", code?: string): URL {
  const url = new URL("/seller", APP_URL);
  url.searchParams.set("shopify", status);
  if (code) url.searchParams.set("code", code);
  return url;
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function GET(req: Request): Promise<Response> {
  const res = await handleCallback(req);
  // State-ul e de unică folosință: cookie-ul de legare nu mai are rost după callback.
  res.headers.append("Set-Cookie", clearShopifyOAuthBrowserCookie());
  return res;
}

async function handleCallback(req: Request): Promise<Response> {
  const rl = await rateLimit("oauthCallback", `shopify-seller:${getClientIP(req)}`);
  if (!rl.success) {
    return NextResponse.redirect(integrationsUrl("error", "rate_limited"), 303);
  }

  const url = new URL(req.url);
  if (!verifyShopifyOAuthHmac(url)) {
    logger.warn("[seller/shopify-oauth] invalid callback HMAC");
    return NextResponse.redirect(integrationsUrl("error", "invalid_hmac"), 303);
  }

  const shop = url.searchParams.get("shop") || "";
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  if (!shop || !state || !code) {
    return NextResponse.redirect(integrationsUrl("error", "invalid_callback"), 303);
  }

  if (!shopifyOAuthBrowserMatches(state, readCookie(req, SHOPIFY_OAUTH_BROWSER_COOKIE))) {
    logger.warn({ shop }, "[seller/shopify-oauth] callback not bound to the initiating browser");
    return NextResponse.redirect(integrationsUrl("error", "invalid_state"), 303);
  }

  try {
    const claimed = await consumeShopifyOAuthState(shop, state);
    if (!claimed) {
      return NextResponse.redirect(integrationsUrl("error", "invalid_state"), 303);
    }

    const credentials = await exchangeShopifyOAuthCode(claimed.shop, code);
    const requestedScopes = new Set(shopifyOAuthScopes());
    const grantedScopes = new Set(
      (credentials.scope || "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    );
    const missingScopes = [...requestedScopes].filter((scope) => !grantedScopes.has(scope));
    if (missingScopes.length > 0) {
      logger.warn(
        { shop: claimed.shop, missingScopes },
        "[seller/shopify-oauth] requested scopes were not granted",
      );
      return NextResponse.redirect(integrationsUrl("error", "missing_scopes"), 303);
    }

    // Small authenticated probe: validates the token and captures the shop currency.
    const probe = await fetchCatalogPage("shopify", {
      externalAccountId: claimed.shop,
      credentials,
      cursor: null,
      limit: 1,
    });

    await upsertCatalogConnection({
      sellerId: claimed.sellerId,
      provider: "shopify",
      externalAccountId: claimed.shop,
      credentials,
      config: {
        storeCurrency: probe.storeCurrency,
        authMode: "oauth",
        oauthConnectedAt: new Date().toISOString(),
        bootstrapRequestedAt: new Date().toISOString(),
      },
    });

    // The minute worker will immediately pick this integration up for webhook
    // setup + bootstrap reconciliation of catalog, CRM and order history.
    return NextResponse.redirect(integrationsUrl("connected"), 303);
  } catch (error) {
    const code =
      error instanceof CatalogProviderError ? error.code : "shopify_oauth_callback_failed";
    logger.error({ err: error, shop }, "[seller/shopify-oauth] callback failed");
    return NextResponse.redirect(integrationsUrl("error", code), 303);
  }
}
