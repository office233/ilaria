import { NextResponse } from "next/server";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import {
  createShopifyOAuthState,
  isShopifyOAuthConfigured,
  shopifyOAuthBrowserCookie,
} from "@/lib/seller/imports/shopify-oauth";
import { CatalogProviderError } from "@/lib/seller/imports/common";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.redirect(new URL("/seller/login?next=/seller", req.url), 303);
  }
  if (!isShopifyOAuthConfigured()) {
    return NextResponse.redirect(
      new URL("/seller?shopify=error&code=oauth_not_configured", req.url),
      303,
    );
  }

  const rl = await rateLimit("sellerIntegrations", sellerId);
  if (!rl.success) {
    return NextResponse.redirect(
      new URL("/seller?shopify=error&code=rate_limited", req.url),
      303,
    );
  }

  const shop = new URL(req.url).searchParams.get("shop") || "";
  try {
    const oauth = await createShopifyOAuthState(sellerId, shop);
    const res = NextResponse.redirect(oauth.authorizationUrl, 303);
    res.headers.append("Set-Cookie", shopifyOAuthBrowserCookie(oauth.state));
    return res;
  } catch (error) {
    const code =
      error instanceof CatalogProviderError ? error.code : "shopify_oauth_start_failed";
    return NextResponse.redirect(
      new URL(
        `/seller?shopify=error&code=${encodeURIComponent(code)}`,
        req.url,
      ),
      303,
    );
  }
}
