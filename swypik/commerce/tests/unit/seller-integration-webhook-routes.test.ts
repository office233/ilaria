import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findIntegration: vi.fn(),
  tombstoneIntegration: vi.fn(),
  processPrivacy: vi.fn(),
  enqueue: vi.fn(),
  shopifySecret: vi.fn(),
  decryptWooSecret: vi.fn(),
}));

vi.mock("@/lib/seller/imports/connections", () => ({
  findCatalogIntegrationByAccount: h.findIntegration,
  tombstoneShopifyIntegration: h.tombstoneIntegration,
}));
vi.mock("@/lib/seller/imports/shopify-privacy-webhook", () => ({
  isShopifyPrivacyTopic: (topic: string) =>
    topic === "customers/data_request" || topic === "customers/redact" || topic === "shop/redact",
  processShopifyPrivacyTopic: h.processPrivacy,
}));
vi.mock("@/lib/seller/imports/webhook-events", () => ({
  enqueueWebhookEvent: h.enqueue,
}));
vi.mock("@/lib/seller/imports/webhooks", () => ({
  shopifyWebhookSecret: h.shopifySecret,
  decryptWooWebhookSecret: h.decryptWooSecret,
}));

import { POST as shopifyPost } from "@/app/api/webhooks/commerce/shopify/route";
import { POST as wooPost } from "@/app/api/webhooks/commerce/woocommerce/route";

function signature(raw: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(raw).digest("base64");
}

beforeEach(() => {
  h.findIntegration.mockReset();
  h.tombstoneIntegration.mockReset().mockResolvedValue(undefined);
  h.processPrivacy.mockReset().mockResolvedValue(undefined);
  h.enqueue.mockReset().mockResolvedValue(true);
  h.shopifySecret.mockReset().mockReturnValue("shopify-secret");
  h.decryptWooSecret.mockReset().mockReturnValue("woo-secret");
});

describe("Shopify commerce webhook route", () => {
  it("verifies signature and enqueues one normalized event", async () => {
    const raw = JSON.stringify({ id: 123 });
    h.findIntegration.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      sellerId: "22222222-2222-4222-8222-222222222222",
      webhookSecretEnc: null,
    });
    const res = await shopifyPost(new Request("https://swypik.com/api/webhooks/commerce/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": signature(raw, "shopify-secret"),
        "x-shopify-shop-domain": "store.myshopify.com",
        "x-shopify-topic": "products/update",
        "x-shopify-webhook-id": "delivery-1",
        "x-shopify-triggered-at": "2026-09-29T18:00:00Z",
      },
      body: raw,
    }));
    expect(res.status).toBe(200);
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "delivery-1",
      resource: "product",
      action: "update",
      externalResourceId: "gid://shopify/Product/123",
    }));
  });

  it("rejects a bad HMAC before enqueue", async () => {
    const raw = JSON.stringify({ id: 123 });
    const res = await shopifyPost(new Request("https://swypik.com/api/webhooks/commerce/shopify", {
      method: "POST",
      headers: {
        "x-shopify-hmac-sha256": "bad",
        "x-shopify-shop-domain": "store.myshopify.com",
        "x-shopify-topic": "products/update",
        "x-shopify-webhook-id": "delivery-2",
      },
      body: raw,
    }));
    expect(res.status).toBe(401);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("tombstones local credentials when Shopify reports app/uninstalled", async () => {
    const raw = JSON.stringify({ id: 123 });
    h.findIntegration.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      sellerId: "22222222-2222-4222-8222-222222222222",
      webhookSecretEnc: null,
    });
    const res = await shopifyPost(new Request("https://swypik.com/api/webhooks/commerce/shopify", {
      method: "POST",
      headers: {
        "x-shopify-hmac-sha256": signature(raw, "shopify-secret"),
        "x-shopify-shop-domain": "store.myshopify.com",
        "x-shopify-topic": "app/uninstalled",
        "x-shopify-webhook-id": "delivery-uninstall",
      },
      body: raw,
    }));
    expect(res.status).toBe(200);
    expect(h.tombstoneIntegration).toHaveBeenCalledWith({
      integrationId: "11111111-1111-4111-8111-111111111111",
      sellerId: "22222222-2222-4222-8222-222222222222",
      shop: "store.myshopify.com",
    });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("routes mandatory customer redaction through the shared privacy processor", async () => {
    const raw = JSON.stringify({
      shop_domain: "store.myshopify.com",
      customer: { id: 88 },
      orders_to_redact: [1001],
    });
    const res = await shopifyPost(new Request("https://swypik.com/api/webhooks/commerce/shopify", {
      method: "POST",
      headers: {
        "x-shopify-hmac-sha256": signature(raw, "shopify-secret"),
        "x-shopify-shop-domain": "store.myshopify.com",
        "x-shopify-topic": "customers/redact",
        "x-shopify-webhook-id": "delivery-redact",
      },
      body: raw,
    }));
    expect(res.status).toBe(200);
    expect(h.processPrivacy).toHaveBeenCalledWith("customers/redact", raw);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe("WooCommerce commerce webhook route", () => {
  it("uses the encrypted per-store secret and enqueues the delivery once", async () => {
    const raw = JSON.stringify({ id: 77 });
    h.findIntegration.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      sellerId: "22222222-2222-4222-8222-222222222222",
      webhookSecretEnc: "v1:encrypted",
    });
    const res = await wooPost(new Request("https://swypik.com/api/webhooks/commerce/woocommerce", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wc-webhook-source": "https://shop.example.com/",
        "x-wc-webhook-topic": "order.updated",
        "x-wc-webhook-delivery-id": "54",
        "x-wc-webhook-signature": signature(raw, "woo-secret"),
      },
      body: raw,
    }));
    expect(res.status).toBe(200);
    expect(h.decryptWooSecret).toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      provider: "woocommerce",
      deliveryId: expect.stringMatching(/^54:order\.updated:77:[0-9a-f]{16}$/),
      resource: "order",
      action: "update",
      externalResourceId: "77",
    }));
  });

  it("keeps distinct events that share a WooCommerce delivery id (same second)", async () => {
    h.findIntegration.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      sellerId: "22222222-2222-4222-8222-222222222222",
      webhookSecretEnc: "v1:encrypted",
    });
    const send = (raw: string) => wooPost(new Request("https://swypik.com/api/webhooks/commerce/woocommerce", {
      method: "POST",
      headers: {
        "x-wc-webhook-source": "https://shop.example.com/",
        "x-wc-webhook-topic": "product.updated",
        "x-wc-webhook-delivery-id": "same-second",
        "x-wc-webhook-signature": signature(raw, "woo-secret"),
      },
      body: raw,
    }));
    await send(JSON.stringify({ id: 1, name: "A" }));
    await send(JSON.stringify({ id: 2, name: "B" }));
    const [first, second] = h.enqueue.mock.calls.map((call) => call[0].deliveryId);
    expect(first).not.toBe(second);
  });

  it("returns 503 instead of crashing when the stored secret cannot be decrypted", async () => {
    const raw = JSON.stringify({ id: 77 });
    h.findIntegration.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      sellerId: "22222222-2222-4222-8222-222222222222",
      webhookSecretEnc: "v1:corrupt",
    });
    h.decryptWooSecret.mockImplementation(() => { throw new Error("bad auth tag"); });
    const res = await wooPost(new Request("https://swypik.com/api/webhooks/commerce/woocommerce", {
      method: "POST",
      headers: {
        "x-wc-webhook-source": "https://shop.example.com/",
        "x-wc-webhook-topic": "order.updated",
        "x-wc-webhook-delivery-id": "54",
        "x-wc-webhook-signature": signature(raw, "woo-secret"),
      },
      body: raw,
    }));
    expect(res.status).toBe(503);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
