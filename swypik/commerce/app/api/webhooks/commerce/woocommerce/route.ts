import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { parsePublicHttpsUrl } from "@/lib/security/ssrf";
import { readWebhookBody, WebhookBodyTooLargeError } from "@/lib/webhooks/raw-body";
import { findCatalogIntegrationByAccount } from "@/lib/seller/imports/connections";
import { decryptWooWebhookSecret } from "@/lib/seller/imports/webhooks";
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

function canonicalSource(raw: string): string {
  const url = parsePublicHttpsUrl(raw);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

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

  const topicRaw = req.headers.get("x-wc-webhook-topic") || "";
  const sourceRaw = req.headers.get("x-wc-webhook-source") || "";
  const deliveryId = req.headers.get("x-wc-webhook-delivery-id") || "";
  if (!topicRaw || !sourceRaw || !deliveryId) {
    return NextResponse.json({ success: false, error: "missing_headers" }, { status: 400 });
  }

  let source: string;
  try {
    source = canonicalSource(sourceRaw);
  } catch {
    return NextResponse.json({ success: false, error: "invalid_source" }, { status: 400 });
  }
  const integration = await findCatalogIntegrationByAccount("woocommerce", source);
  if (!integration) return NextResponse.json({ success: true, ignored: true });
  if (!integration.webhookSecretEnc) {
    return NextResponse.json({ success: false, error: "webhook_not_configured" }, { status: 503 });
  }

  let secret: string;
  try {
    secret = decryptWooWebhookSecret(integration.id, integration.webhookSecretEnc);
  } catch (error) {
    logger.error({ err: error, integrationId: integration.id }, "[commerce/woocommerce-webhook] secret decrypt failed");
    return NextResponse.json({ success: false, error: "webhook_not_configured" }, { status: 503 });
  }
  if (!verifyBase64HmacSha256(raw, req.headers.get("x-wc-webhook-signature"), secret)) {
    logger.warn({ integrationId: integration.id }, "[commerce/woocommerce-webhook] invalid signature");
    return NextResponse.json({ success: false, error: "invalid_signature" }, { status: 401 });
  }

  const topic = parseWebhookTopic("woocommerce", topicRaw);
  if (!topic) return NextResponse.json({ success: true, ignored: true });
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 });
  }
  const externalResourceId = externalIdFromWebhookPayload("woocommerce", topic, payload, topicRaw);
  if (!externalResourceId) {
    return NextResponse.json({ success: false, error: "resource_id_missing" }, { status: 400 });
  }
  const bodyHash = payloadSha256(raw);
  const created = await enqueueWebhookEvent({
    integrationId: integration.id,
    provider: "woocommerce",
    // WooCommerce derivă X-WC-Webhook-Delivery-ID din id-ul webhook-ului + secunda
    // curentă, deci N produse editate în aceeași secundă au același id. Cheia de
    // dedupe include resursa și conținutul: o livrare identică rămâne duplicat,
    // evenimente diferite din aceeași secundă nu se mai pierd.
    deliveryId: `${deliveryId}:${topicRaw}:${externalResourceId}:${bodyHash.slice(0, 16)}`,
    topic: topicRaw,
    resource: topic.resource,
    action: topic.action,
    externalResourceId,
    payloadSha256: bodyHash,
    triggeredAt: null,
  });
  return NextResponse.json({ success: true, duplicate: !created });
}
