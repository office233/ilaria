import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dataRequest: vi.fn(),
  customerRedact: vi.fn(),
  shopRedact: vi.fn(),
  secret: vi.fn(),
}));

vi.mock("@/lib/seller/imports/shopify-privacy", () => ({
  parseShopifyPrivacyPayload: (raw: string) => JSON.parse(raw),
  recordShopifyDataRequest: h.dataRequest,
  redactShopifyCustomer: h.customerRedact,
  redactShopifyShop: h.shopRedact,
}));
vi.mock("@/lib/seller/imports/webhooks", () => ({
  shopifyWebhookSecret: h.secret,
}));

import { POST as dataRequestPost } from "@/app/api/webhooks/commerce/shopify/customers-data-request/route";
import { POST as customerRedactPost } from "@/app/api/webhooks/commerce/shopify/customers-redact/route";
import { POST as shopRedactPost } from "@/app/api/webhooks/commerce/shopify/shop-redact/route";

const SECRET = "shopify-client-secret";

function signedRequest(path: string, payload: object, valid = true): Request {
  const raw = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", SECRET).update(raw).digest("base64");
  return new Request(`https://swypik.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": valid ? signature : "invalid",
    },
    body: raw,
  });
}

beforeEach(() => {
  h.dataRequest.mockReset().mockResolvedValue(undefined);
  h.customerRedact.mockReset().mockResolvedValue(undefined);
  h.shopRedact.mockReset().mockResolvedValue(undefined);
  h.secret.mockReset().mockReturnValue(SECRET);
});

describe("Shopify mandatory privacy webhooks", () => {
  it("accepts customers/data_request and dispatches only the data-request handler", async () => {
    const payload = {
      shop_id: 1,
      shop_domain: "store.myshopify.com",
      customer: { id: 2, email: "person@example.com" },
      data_request: { id: 3 },
      orders_requested: [4],
    };
    const res = await dataRequestPost(
      signedRequest(
        "/api/webhooks/commerce/shopify/customers-data-request",
        payload,
      ),
    );
    expect(res.status).toBe(200);
    expect(h.dataRequest).toHaveBeenCalledWith(
      expect.objectContaining({ shop_domain: "store.myshopify.com" }),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(h.customerRedact).not.toHaveBeenCalled();
    expect(h.shopRedact).not.toHaveBeenCalled();
  });

  it("dispatches customers/redact and shop/redact to their destructive handlers", async () => {
    const customer = await customerRedactPost(
      signedRequest(
        "/api/webhooks/commerce/shopify/customers-redact",
        {
          shop_domain: "store.myshopify.com",
          customer: { id: 2 },
          orders_to_redact: [4],
        },
      ),
    );
    const shop = await shopRedactPost(
      signedRequest(
        "/api/webhooks/commerce/shopify/shop-redact",
        { shop_id: 1, shop_domain: "store.myshopify.com" },
      ),
    );
    expect(customer.status).toBe(200);
    expect(shop.status).toBe(200);
    expect(h.customerRedact).toHaveBeenCalledTimes(1);
    expect(h.shopRedact).toHaveBeenCalledTimes(1);
  });

  it("returns 401 and performs no privacy action when HMAC is invalid", async () => {
    const res = await shopRedactPost(
      signedRequest(
        "/api/webhooks/commerce/shopify/shop-redact",
        { shop_id: 1, shop_domain: "store.myshopify.com" },
        false,
      ),
    );
    expect(res.status).toBe(401);
    expect(h.dataRequest).not.toHaveBeenCalled();
    expect(h.customerRedact).not.toHaveBeenCalled();
    expect(h.shopRedact).not.toHaveBeenCalled();
  });
});
