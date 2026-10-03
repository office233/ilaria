import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { readWebhookBody, WebhookBodyTooLargeError } from "@/lib/webhooks/raw-body";
import { normalizeShopifyStore } from "@/lib/seller/imports/shopify";
import {
  findCatalogIntegrationByAccount,
  tombstoneShopifyIntegration,
} from "@/lib/seller/imports/connections";
import { shopifyWebhookSecret } from "@/lib/seller/imports/webhooks";
import {
  isShopifyPrivacyTopic,
  processShopifyPrivacyTopic,
} from "@/lib/seller/imports/shopify-privacy-webhook";
import {
  payloadSha256,
  verifyBase64HmacSha256,
} from "@/lib/seller/imports/webhook-signature";
import {
  externalIdFromWebhookPayload,
  parseWebhookTopic,
} from "@/lib/seller/imports/webhook-topic";
import { enqueueWebhookEvent } from "@/lib/seller/imports/webhook-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let raw: string;
  try {
    raw = await readWebhookBody(req);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof WebhookBodyTooLargeError ? "payload_too_large" : "invalid_body" },
      { status: error instanceof WebhookBodyTooLargeError ? 413 : 400 },
    );
  }

  const secret = shopifyWebhookSecret();
  const signature = req.headers.get("x-shopify-hmac-sha256");
  if (!secret || !verifyBase64HmacSha256(raw, signature, secret)) {
    logger.warn("[commerce/shopify-webhook] invalid signature");
    return NextResponse.json({ success: false, error: "invalid_signature" }, { status: 401 });
  }

  const rawShop = req.headers.get("x-shopify-shop-domain") || "";
  const topicRaw = req.headers.get("x-shopify-topic") || "";
  const deliveryId = req.headers.get("x-shopify-webhook-id") || "";
  if (!rawShop || !topicRaw || !deliveryId) {
    return NextResponse.json({ success: false, error: "missing_headers" }, { status: 400 });
  }

  let shop: string;
  try {
    shop = normalizeShopifyStore(rawShop);
  } catch {
    return NextResponse.json({ success: false, error: "invalid_shop" }, { status: 400 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 });
  }

  const topicLower = topicRaw.trim().toLowerCase();
  if (isShopifyPrivacyTopic(topicLower)) {
    try {
      await processShopifyPrivacyTopic(topicLower, raw);
    } catch (error) {
      logger.error({ err: error, topic: topicLower, shop }, "[commerce/shopify-webhook] privacy handler failed");
      // Non-2xx asks Shopify to retry transient failures.
      return NextResponse.json({ success: false, error: "privacy_webhook_failed" }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  }

  const integration = await findCatalogIntegrationByAccount("shopify", shop);
  if (!integration) return NextResponse.json({ success: true, ignored: true });

  if (topicLower === "app/uninstalled") {
    await tombstoneShopifyIntegration({
      integrationId: integration.id,
      sellerId: integration.sellerId,
      shop,
    });
    logger.info(
      { integrationId: integration.id, shop },
      "[commerce/shopify-webhook] app uninstalled; credentials tombstoned",
    );
    return NextResponse.json({ success: true, disconnected: true });
  }

  const topic = parseWebhookTopic("shopify", topicRaw);
  if (!topic) return NextResponse.json({ success: true, ignored: true });

  const externalResourceId = externalIdFromWebhookPayload("shopify", topic, payload, topicRaw);
  if (!externalResourceId) {
    return NextResponse.json({ success: false, error: "resource_id_missing" }, { status: 400 });
  }
  const created = await enqueueWebhookEvent({
    integrationId: integration.id,
    provider: "shopify",
    deliveryId,
    topic: topicRaw,
    resource: topic.resource,
    action: topic.action,
    externalResourceId,
    payloadSha256: payloadSha256(raw),
    triggeredAt: req.headers.get("x-shopify-triggered-at"),
  });
  return NextResponse.json({ success: true, duplicate: !created });
}
