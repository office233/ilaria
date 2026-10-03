import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import {
  listCatalogConnections,
  upsertCatalogConnection,
} from "@/lib/seller/imports/connections";
import { CatalogProviderError } from "@/lib/seller/imports/common";
import { fetchCatalogPage } from "@/lib/seller/imports/provider";
import { normalizeShopifyStore } from "@/lib/seller/imports/shopify";
import { normalizeWooStore } from "@/lib/seller/imports/woocommerce";
import type { CatalogCredentials, CatalogProvider } from "@/lib/seller/imports/types";

export const dynamic = "force-dynamic";

const ConnectSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("shopify"),
    store: z.string().trim().min(3).max(255),
    accessToken: z.string().trim().min(8).max(1024),
  }).strict(),
  z.object({
    provider: z.literal("woocommerce"),
    storeUrl: z.string().trim().url().max(2048),
    consumerKey: z.string().trim().min(8).max(512),
    consumerSecret: z.string().trim().min(8).max(1024),
  }).strict(),
]);

function providerError(error: CatalogProviderError): Response {
  return NextResponse.json(
    { success: false, error: error.code },
    { status: error.status },
  );
}

export async function GET(): Promise<Response> {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json({
      success: true,
      integrations: await listCatalogConnections(sellerId),
    });
  } catch (error) {
    logger.error({ err: error, sellerId }, "[seller/integrations] list failed");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const rl = await rateLimit("sellerIntegrations", sellerId);
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  const parsed = ConnectSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "validation_error" }, { status: 400 });
  }

  try {
    let provider: CatalogProvider;
    let externalAccountId: string;
    let credentials: CatalogCredentials;

    if (parsed.data.provider === "shopify") {
      provider = "shopify";
      externalAccountId = normalizeShopifyStore(parsed.data.store);
      credentials = { accessToken: parsed.data.accessToken };
    } else {
      provider = "woocommerce";
      externalAccountId = await normalizeWooStore(parsed.data.storeUrl);
      credentials = {
        consumerKey: parsed.data.consumerKey,
        consumerSecret: parsed.data.consumerSecret,
      };
    }

    // Verify credentials and provider response before persisting the secret.
    const probe = await fetchCatalogPage(provider, {
      externalAccountId,
      credentials,
      cursor: null,
      limit: 1,
    });

    const integration = await upsertCatalogConnection({
      sellerId,
      provider,
      externalAccountId,
      credentials,
      config: { storeCurrency: probe.storeCurrency },
    });

    return NextResponse.json({ success: true, integration }, { status: 201 });
  } catch (error) {
    if (error instanceof CatalogProviderError) return providerError(error);
    logger.error({ err: error, sellerId }, "[seller/integrations] connect failed");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
