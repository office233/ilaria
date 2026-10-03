import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  payloadSha256,
  verifyBase64HmacSha256,
} from "@/lib/seller/imports/webhook-signature";
import {
  externalIdFromWebhookPayload,
  parseWebhookTopic,
} from "@/lib/seller/imports/webhook-topic";

describe("commerce webhook verification", () => {
  it("verifies raw-body HMAC in constant-length form", () => {
    const raw = JSON.stringify({ id: 42, title: "Produs" });
    const secret = "super-secret";
    const signature = crypto.createHmac("sha256", secret).update(raw).digest("base64");
    expect(verifyBase64HmacSha256(raw, signature, secret)).toBe(true);
    expect(verifyBase64HmacSha256(raw + " ", signature, secret)).toBe(false);
    expect(verifyBase64HmacSha256(raw, null, secret)).toBe(false);
    expect(payloadSha256(raw)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("commerce webhook topics", () => {
  it("maps Shopify topics and converts legacy numeric ids to GraphQL gids", () => {
    const topic = parseWebhookTopic("shopify", "products/update");
    expect(topic).toEqual({ resource: "product", action: "update" });
    expect(externalIdFromWebhookPayload("shopify", topic!, { id: 123 }, "products/update"))
      .toBe("gid://shopify/Product/123");
  });

  it("maps Shopify refunds to the parent order", () => {
    const topic = parseWebhookTopic("shopify", "refunds/create");
    expect(topic).toEqual({ resource: "order", action: "update" });
    expect(externalIdFromWebhookPayload("shopify", topic!, { order_id: 77 }, "refunds/create"))
      .toBe("gid://shopify/Order/77");
  });

  it("maps WooCommerce topics without changing numeric ids", () => {
    const topic = parseWebhookTopic("woocommerce", "customer.updated");
    expect(topic).toEqual({ resource: "customer", action: "update" });
    expect(externalIdFromWebhookPayload("woocommerce", topic!, { id: 9 }, "customer.updated"))
      .toBe("9");
  });
});
