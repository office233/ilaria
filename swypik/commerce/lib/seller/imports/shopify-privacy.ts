import { dbQuery, withTransaction } from "@/lib/db";
import { normalizeShopifyStore } from "./shopify-domain";

type PrivacyPayload = {
  shop_id?: string | number;
  shop_domain?: string;
  orders_requested?: Array<string | number>;
  orders_to_redact?: Array<string | number>;
  customer?: {
    id?: string | number;
    email?: string;
    phone?: string;
  };
  data_request?: {
    id?: string | number;
  };
};

function scalarId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value).trim();
  return id ? id : null;
}

function customerIds(payload: PrivacyPayload): string[] {
  const id = scalarId(payload.customer?.id);
  if (!id) return [];
  return [id, id.startsWith("gid://shopify/") ? id : `gid://shopify/Customer/${id}`];
}

function orderIds(values: Array<string | number> | undefined): string[] {
  const ids = new Set<string>();
  for (const value of values ?? []) {
    const id = scalarId(value);
    if (!id) continue;
    ids.add(id);
    ids.add(id.startsWith("gid://shopify/") ? id : `gid://shopify/Order/${id}`);
  }
  return [...ids];
}

async function sellerIdForShop(shop: string): Promise<string | null> {
  const { rows } = await dbQuery<{ seller_id: string }>(
    `SELECT seller_id
       FROM seller_catalog_integrations
      WHERE provider = 'shopify' AND external_account_id = $1
      LIMIT 1`,
    [shop],
  );
  if (rows[0]?.seller_id) return rows[0].seller_id;

  const historical = await dbQuery<{ seller_id: string }>(
    `SELECT seller_id
       FROM seller_imported_orders
      WHERE provider = 'shopify' AND external_account_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [shop],
  );
  return historical.rows[0]?.seller_id ?? null;
}

export function parseShopifyPrivacyPayload(raw: string): PrivacyPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("invalid_payload");
  return parsed as PrivacyPayload;
}

export async function recordShopifyDataRequest(
  payload: PrivacyPayload,
  payloadSha256: string,
): Promise<void> {
  const shop = normalizeShopifyStore(payload.shop_domain || "");
  const requestId = scalarId(payload.data_request?.id);
  if (!requestId) throw new Error("request_id_missing");
  const sellerId = await sellerIdForShop(shop);
  const customerId = customerIds(payload)[0] ?? null;
  const requestedOrders = orderIds(payload.orders_requested);

  await dbQuery(
    `INSERT INTO seller_shopify_privacy_requests
       (seller_id, shop, topic, external_request_id, customer_external_id,
        order_external_ids, status, payload_sha256)
     VALUES ($1, $2, 'customers/data_request', $3, $4, $5::jsonb, 'received', $6)
     ON CONFLICT (shop, topic, external_request_id) DO NOTHING`,
    [sellerId, shop, requestId, customerId, JSON.stringify(requestedOrders), payloadSha256],
  );
}

export async function redactShopifyCustomer(
  payload: PrivacyPayload,
  payloadSha256: string,
): Promise<void> {
  const shop = normalizeShopifyStore(payload.shop_domain || "");
  const ids = customerIds(payload);
  if (ids.length === 0) throw new Error("customer_id_missing");
  const sellerId = await sellerIdForShop(shop);
  const requestId =
    scalarId(payload.customer?.id) ??
    `customer-redact:${payloadSha256.slice(0, 24)}`;
  const requestedOrders = orderIds(payload.orders_to_redact);

  await withTransaction(async (q) => {
    await q(
      `DELETE FROM seller_clients
        WHERE external_source = 'shopify'
          AND external_account_id = $1
          AND external_customer_id = ANY($2::text[])`,
      [shop, ids],
    );
    await q(
      `UPDATE seller_imported_orders
          SET customer_name = NULL,
              customer_email = NULL,
              customer_phone = NULL,
              customer_external_id = NULL,
              metadata = metadata - 'customer' - 'billing' - 'shipping_address',
              updated_at = now()
        WHERE provider = 'shopify'
          AND external_account_id = $1
          AND (
            customer_external_id = ANY($2::text[])
            OR external_order_id = ANY($3::text[])
          )`,
      [shop, ids, requestedOrders],
    );
    await q(
      `INSERT INTO seller_shopify_privacy_requests
         (seller_id, shop, topic, external_request_id, customer_external_id,
          order_external_ids, status, payload_sha256, processed_at)
       VALUES ($1, $2, 'customers/redact', $3, $4, $5::jsonb, 'completed', $6, now())
       ON CONFLICT (shop, topic, external_request_id)
       DO UPDATE SET status = 'completed', error_code = NULL, processed_at = now()`,
      [
        sellerId,
        shop,
        requestId,
        ids[0],
        JSON.stringify(requestedOrders),
        payloadSha256,
      ],
    );
  });
}

export async function redactShopifyShop(
  payload: PrivacyPayload,
  payloadSha256: string,
): Promise<void> {
  const shop = normalizeShopifyStore(payload.shop_domain || "");
  const shopId = scalarId(payload.shop_id) ?? `shop-redact:${payloadSha256.slice(0, 24)}`;
  const sellerId = await sellerIdForShop(shop);

  await withTransaction(async (q) => {
    await q(
      `DELETE FROM seller_clients
        WHERE external_source = 'shopify' AND external_account_id = $1`,
      [shop],
    );
    await q(
      `DELETE FROM marketplace_products
        WHERE source_type = 'shopify' AND supplier = $1`,
      [shop],
    );
    await q(
      `DELETE FROM seller_imported_orders
        WHERE provider = 'shopify' AND external_account_id = $1`,
      [shop],
    );
    await q(
      `DELETE FROM seller_catalog_integrations
        WHERE provider = 'shopify' AND external_account_id = $1`,
      [shop],
    );
    await q(
      `DELETE FROM seller_shopify_oauth_states WHERE shop = $1`,
      [shop],
    );
    await q(
      `INSERT INTO seller_shopify_privacy_requests
         (seller_id, shop, topic, external_request_id, status, payload_sha256, processed_at)
       VALUES ($1, $2, 'shop/redact', $3, 'completed', $4, now())
       ON CONFLICT (shop, topic, external_request_id)
       DO UPDATE SET status = 'completed', error_code = NULL, processed_at = now()`,
      [sellerId, shop, shopId, payloadSha256],
    );
  });
}
