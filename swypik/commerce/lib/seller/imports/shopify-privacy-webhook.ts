import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import {
  readWebhookBody,
  WebhookBodyTooLargeError,
} from "@/lib/webhooks/raw-body";
import { payloadSha256, verifyBase64HmacSha256 } from "./webhook-signature";
import { shopifyWebhookSecret } from "./webhooks";
import {
  parseShopifyPrivacyPayload,
  recordShopifyDataRequest,
  redactShopifyCustomer,
  redactShopifyShop,
} from "./shopify-privacy";

export type ShopifyPrivacyTopic =
  | "customers/data_request"
  | "customers/redact"
  | "shop/redact";

export function isShopifyPrivacyTopic(topic: string): topic is ShopifyPrivacyTopic {
  return (
    topic === "customers/data_request" ||
    topic === "customers/redact" ||
    topic === "shop/redact"
  );
}

// Shared by the dedicated per-topic routes and the generic Shopify webhook
// route (the URL registered in shopify.app.toml), so both write the same
// seller_shopify_privacy_requests schema.
export async function processShopifyPrivacyTopic(
  topic: ShopifyPrivacyTopic,
  raw: string,
): Promise<void> {
  const payload = parseShopifyPrivacyPayload(raw);
  const digest = payloadSha256(raw);
  if (topic === "customers/data_request") {
    await recordShopifyDataRequest(payload, digest);
    return;
  }
  if (topic === "customers/redact") {
    await redactShopifyCustomer(payload, digest);
    return;
  }
  await redactShopifyShop(payload, digest);
}

export async function handleShopifyPrivacyWebhook(
  req: Request,
  topic: ShopifyPrivacyTopic,
): Promise<Response> {
  let raw: string;
  try {
    raw = await readWebhookBody(req);
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof WebhookBodyTooLargeError
            ? "payload_too_large"
            : "invalid_body",
      },
      { status: error instanceof WebhookBodyTooLargeError ? 413 : 400 },
    );
  }

  const secret = shopifyWebhookSecret();
  const signature = req.headers.get("x-shopify-hmac-sha256");
  if (!secret || !verifyBase64HmacSha256(raw, signature, secret)) {
    logger.warn({ topic }, "[shopify/privacy] invalid signature");
    return NextResponse.json(
      { success: false, error: "invalid_signature" },
      { status: 401 },
    );
  }

  try {
    await processShopifyPrivacyTopic(topic, raw);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "privacy_webhook_failed";
    if (message === "invalid_json" || message === "invalid_payload") {
      return NextResponse.json(
        { success: false, error: message },
        { status: 400 },
      );
    }
    logger.error({ err: error, topic }, "[shopify/privacy] handler failed");
    // Non-2xx intentionally asks Shopify to retry transient failures.
    return NextResponse.json(
      { success: false, error: "privacy_webhook_failed" },
      { status: 500 },
    );
  }
}
