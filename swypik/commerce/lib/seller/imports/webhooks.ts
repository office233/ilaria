import crypto from "node:crypto";
import { APP_URL } from "@/lib/app-url";
import { dbQuery } from "@/lib/db";
import { safeFetch } from "@/lib/security/ssrf";
import { decryptSecret, encryptSecret } from "@/lib/security/secret-box";
import { intEnv } from "@/lib/config/env";
import type {
  CatalogConnection,
  ShopifyCredentials,
  WooCommerceCredentials,
} from "./types";
import { CatalogProviderError } from "./common";
import { updateWebhookState } from "./connections";
import {
  ensureFreshShopifyCredentials,
  shopifyClientSecret,
} from "./shopify-oauth";

const SHOPIFY_TOPICS = [
  "APP_UNINSTALLED",
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "PRODUCTS_DELETE",
  "CUSTOMERS_CREATE",
  "CUSTOMERS_UPDATE",
  "CUSTOMERS_DELETE",
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "ORDERS_DELETE",
  "REFUNDS_CREATE",
] as const;

const WOO_TOPICS = [
  "product.created",
  "product.updated",
  "product.deleted",
  "customer.created",
  "customer.updated",
  "customer.deleted",
  "order.created",
  "order.updated",
  "order.deleted",
] as const;

type WebhookSetupResult = {
  status: "active" | "degraded" | "unavailable";
  configured: number;
  expected: number;
  errors: string[];
};

function webhookPurpose(integrationId: string): string {
  return `seller-catalog-webhook:${integrationId}`;
}

export function shopifyWebhookSecret(): string {
  return shopifyClientSecret();
}

export function decryptWooWebhookSecret(integrationId: string, encrypted: string): string {
  return decryptSecret(webhookPurpose(integrationId), encrypted);
}

async function storedWebhookSecret(integrationId: string): Promise<string | null> {
  const { rows } = await dbQuery<{ webhook_secret_enc: string | null }>(
    "SELECT webhook_secret_enc FROM seller_catalog_integrations WHERE id = $1",
    [integrationId],
  );
  const encrypted = rows[0]?.webhook_secret_enc;
  return encrypted ? decryptWooWebhookSecret(integrationId, encrypted) : null;
}

function shopifyEndpoint(store: string): string {
  const version = process.env.SHOPIFY_API_VERSION?.trim();
  if (!version) throw new CatalogProviderError("shopify_api_version_missing", 500);
  if (!/^20\d{2}-(?:01|04|07|10)$/.test(version)) {
    throw new CatalogProviderError("shopify_api_version_invalid", 500);
  }
  return `https://${store}/admin/api/${version}/graphql.json`;
}

async function shopifyRequest<T>(
  connection: CatalogConnection,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const credentials = await ensureFreshShopifyCredentials({
    sellerId: connection.sellerId,
    integrationId: connection.id,
    shop: connection.externalAccountId,
    credentials: connection.credentials as ShopifyCredentials,
  });
  if (!credentials.accessToken?.trim()) {
    throw new CatalogProviderError("shopify_credentials_missing", 400);
  }
  const response = await safeFetch(shopifyEndpoint(connection.externalAccountId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": credentials.accessToken,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(
      intEnv("CATALOG_IMPORT_HTTP_TIMEOUT_MS", 15_000, 1_000, 60_000),
    ),
  });
  if (!response.ok) {
    throw new CatalogProviderError(
      response.status === 401 || response.status === 403
        ? "shopify_unauthorized"
        : "shopify_webhook_setup_failed",
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }
  const payload = (await response.json().catch(() => null)) as T | null;
  if (!payload) throw new CatalogProviderError("shopify_webhook_setup_failed");
  return payload;
}

async function ensureShopifyWebhooks(connection: CatalogConnection): Promise<WebhookSetupResult> {
  if (!shopifyClientSecret()) {
    await updateWebhookState({
      integrationId: connection.id,
      status: "unavailable",
      config: { reason: "shopify_client_secret_missing" },
    });
    return {
      status: "unavailable",
      configured: 0,
      expected: SHOPIFY_TOPICS.length,
      errors: ["shopify_client_secret_missing"],
    };
  }

  const callbackUrl = `${APP_URL}/api/webhooks/commerce/shopify`;
  const listed = await shopifyRequest<{
    data?: {
      webhookSubscriptions?: {
        edges?: Array<{ node?: { id?: string; topic?: string; uri?: string } }>;
      };
    };
    errors?: Array<{ message?: string }>;
  }>(
    connection,
    `query SwypikWebhookSubscriptions {
      webhookSubscriptions(first: 100) {
        edges { node { id topic uri } }
      }
    }`,
  );
  if (listed.errors?.length) throw new CatalogProviderError("shopify_webhook_setup_failed");

  const existing = new Map<string, string>();
  for (const edge of listed.data?.webhookSubscriptions?.edges ?? []) {
    const node = edge.node;
    if (node?.id && node.topic && node.uri === callbackUrl) existing.set(node.topic, node.id);
  }

  const subscriptions: Array<{ id: string; topic: string }> = [];
  const errors: string[] = [];
  for (const topic of SHOPIFY_TOPICS) {
    const existingId = existing.get(topic);
    if (existingId) {
      subscriptions.push({ id: existingId, topic });
      continue;
    }
    const created = await shopifyRequest<{
      data?: {
        webhookSubscriptionCreate?: {
          webhookSubscription?: { id?: string; topic?: string; uri?: string } | null;
          userErrors?: Array<{ message?: string }>;
        };
      };
      errors?: Array<{ message?: string }>;
    }>(
      connection,
      `mutation SwypikWebhookCreate(
        $topic: WebhookSubscriptionTopic!,
        $subscription: WebhookSubscriptionInput!
      ) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
          webhookSubscription { id topic uri }
          userErrors { message }
        }
      }`,
      { topic, subscription: { uri: callbackUrl, format: "JSON" } },
    );
    const result = created.data?.webhookSubscriptionCreate;
    const id = result?.webhookSubscription?.id;
    if (created.errors?.length || result?.userErrors?.length || !id) {
      errors.push(`shopify:${topic}`);
      continue;
    }
    subscriptions.push({ id, topic });
  }

  const status = errors.length === 0 ? "active" : "degraded";
  await updateWebhookState({
    integrationId: connection.id,
    status,
    config: { callbackUrl, subscriptions, errors },
  });
  return { status, configured: subscriptions.length, expected: SHOPIFY_TOPICS.length, errors };
}

function wooAuth(credentials: WooCommerceCredentials): string {
  if (!credentials.consumerKey?.trim() || !credentials.consumerSecret?.trim()) {
    throw new CatalogProviderError("woocommerce_credentials_missing", 400);
  }
  return `Basic ${Buffer.from(
    `${credentials.consumerKey}:${credentials.consumerSecret}`,
    "utf8",
  ).toString("base64")}`;
}

async function wooRequest<T>(
  connection: CatalogConnection,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const credentials = connection.credentials as WooCommerceCredentials;
  const base = connection.externalAccountId.replace(/\/$/, "");
  const response = await safeFetch(`${base}/wp-json/wc/v3/${path}`, {
    ...init,
    headers: {
      Authorization: wooAuth(credentials),
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(
      intEnv("CATALOG_IMPORT_HTTP_TIMEOUT_MS", 15_000, 1_000, 60_000),
    ),
  });
  if (!response.ok) {
    throw new CatalogProviderError(
      response.status === 401 || response.status === 403
        ? "woocommerce_unauthorized"
        : "woocommerce_webhook_setup_failed",
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }
  const payload = (await response.json().catch(() => null)) as T | null;
  if (!payload) throw new CatalogProviderError("woocommerce_webhook_setup_failed");
  return payload;
}

async function ensureWooWebhooks(connection: CatalogConnection): Promise<WebhookSetupResult> {
  const callbackUrl = `${APP_URL}/api/webhooks/commerce/woocommerce`;
  let secret = await storedWebhookSecret(connection.id);
  let encryptedSecret: string | null = null;
  if (!secret) {
    secret = crypto.randomBytes(32).toString("base64url");
    encryptedSecret = encryptSecret(webhookPurpose(connection.id), secret);
    await updateWebhookState({
      integrationId: connection.id,
      status: "pending",
      encryptedSecret,
      config: { callbackUrl },
    });
  }

  const listed = await wooRequest<Array<{
    id?: number;
    topic?: string;
    delivery_url?: string;
    status?: string;
  }>>(connection, "webhooks?per_page=100");

  const existing = new Map<string, number>();
  for (const hook of listed) {
    if (
      Number.isInteger(hook.id) &&
      hook.topic &&
      hook.delivery_url?.replace(/\/$/, "") === callbackUrl.replace(/\/$/, "")
    ) {
      existing.set(hook.topic, hook.id as number);
    }
  }

  const subscriptions: Array<{ id: number; topic: string }> = [];
  const errors: string[] = [];
  for (const topic of WOO_TOPICS) {
    const existingId = existing.get(topic);
    if (existingId) {
      subscriptions.push({ id: existingId, topic });
      continue;
    }
    try {
      const created = await wooRequest<{ id?: number; topic?: string }>(
        connection,
        "webhooks",
        {
          method: "POST",
          body: JSON.stringify({
            name: `Swypik ${topic}`,
            status: "active",
            topic,
            delivery_url: callbackUrl,
            secret,
          }),
        },
      );
      if (!Number.isInteger(created.id)) {
        errors.push(`woocommerce:${topic}`);
      } else {
        subscriptions.push({ id: created.id as number, topic });
      }
    } catch {
      errors.push(`woocommerce:${topic}`);
    }
  }

  const status = errors.length === 0 ? "active" : "degraded";
  await updateWebhookState({
    integrationId: connection.id,
    status,
    encryptedSecret,
    config: { callbackUrl, subscriptions, errors },
  });
  return { status, configured: subscriptions.length, expected: WOO_TOPICS.length, errors };
}

export async function ensureIntegrationWebhooks(
  connection: CatalogConnection,
): Promise<WebhookSetupResult> {
  return connection.provider === "shopify"
    ? ensureShopifyWebhooks(connection)
    : ensureWooWebhooks(connection);
}

export async function removeIntegrationWebhooks(connection: CatalogConnection): Promise<void> {
  const subscriptions = Array.isArray(connection.webhookConfig?.subscriptions)
    ? connection.webhookConfig.subscriptions as Array<{ id?: string | number; topic?: string }>
    : [];
  if (connection.provider === "shopify") {
    for (const subscription of subscriptions) {
      if (typeof subscription.id !== "string") continue;
      await shopifyRequest(
        connection,
        `mutation SwypikWebhookDelete($id: ID!) {
          webhookSubscriptionDelete(id: $id) {
            deletedWebhookSubscriptionId
            userErrors { message }
          }
        }`,
        { id: subscription.id },
      ).catch(() => undefined);
    }
    return;
  }

  for (const subscription of subscriptions) {
    if (typeof subscription.id !== "number") continue;
    await wooRequest(
      connection,
      `webhooks/${subscription.id}?force=true`,
      { method: "DELETE" },
    ).catch(() => undefined);
  }
}
