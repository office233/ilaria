import { dbQuery } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/security/secret-box";
import type {
  CatalogConnection,
  CatalogConnectionSummary,
  CatalogCredentials,
  CatalogProvider,
} from "./types";
import { CatalogProviderError } from "./common";

type ConnectionRow = {
  id: string;
  seller_id: string;
  provider: CatalogProvider;
  external_account_id: string;
  credentials_enc: string;
  config: Record<string, unknown> | null;
  status: "active" | "disabled" | "error";
  last_sync_at: Date | string | null;
  last_sync_cursor: string | null;
  last_error_code: string | null;
  last_customer_sync_at: Date | string | null;
  last_customer_sync_cursor: string | null;
  last_customer_error_code: string | null;
  last_order_sync_at: Date | string | null;
  last_order_sync_cursor: string | null;
  last_order_error_code: string | null;
  webhook_status: "pending" | "active" | "degraded" | "unavailable";
  webhook_config: Record<string, unknown> | null;
  webhooks_updated_at: Date | string | null;
  last_reconcile_at: Date | string | null;
  last_reconcile_error_code: string | null;
};

type ConnectionSummaryRow = Omit<ConnectionRow, "credentials_enc">;

function purpose(row: Pick<ConnectionRow, "seller_id" | "provider" | "external_account_id">): string {
  return `seller-catalog:${row.seller_id}:${row.provider}:${row.external_account_id}`;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function summary(row: ConnectionSummaryRow): CatalogConnectionSummary {
  return {
    id: row.id,
    sellerId: row.seller_id,
    provider: row.provider,
    externalAccountId: row.external_account_id,
    config: row.config ?? {},
    status: row.status,
    lastSyncAt: iso(row.last_sync_at),
    lastSyncCursor: row.last_sync_cursor,
    lastErrorCode: row.last_error_code,
    lastCustomerSyncAt: iso(row.last_customer_sync_at),
    lastCustomerSyncCursor: row.last_customer_sync_cursor,
    lastCustomerErrorCode: row.last_customer_error_code,
    lastOrderSyncAt: iso(row.last_order_sync_at),
    lastOrderSyncCursor: row.last_order_sync_cursor,
    lastOrderErrorCode: row.last_order_error_code,
    webhookStatus: row.webhook_status,
    webhookConfig: row.webhook_config ?? {},
    webhooksUpdatedAt: iso(row.webhooks_updated_at),
    lastReconcileAt: iso(row.last_reconcile_at),
    lastReconcileErrorCode: row.last_reconcile_error_code,
  };
}

function decodeCredentials(row: ConnectionRow): CatalogCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptSecret(purpose(row), row.credentials_enc));
  } catch {
    throw new CatalogProviderError("catalog_credentials_unreadable", 500);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new CatalogProviderError("catalog_credentials_unreadable", 500);
  }

  if (row.provider === "shopify") {
    const data = parsed as {
      accessToken?: unknown;
      refreshToken?: unknown;
      accessTokenExpiresAt?: unknown;
      refreshTokenExpiresAt?: unknown;
      scope?: unknown;
    };
    const accessToken = data.accessToken;
    if (typeof accessToken !== "string" || !accessToken) {
      throw new CatalogProviderError("catalog_credentials_unreadable", 500);
    }
    return {
      accessToken,
      ...(typeof data.refreshToken === "string" && data.refreshToken ? { refreshToken: data.refreshToken } : {}),
      ...(typeof data.accessTokenExpiresAt === "string" && data.accessTokenExpiresAt
        ? { accessTokenExpiresAt: data.accessTokenExpiresAt }
        : {}),
      ...(typeof data.refreshTokenExpiresAt === "string" && data.refreshTokenExpiresAt
        ? { refreshTokenExpiresAt: data.refreshTokenExpiresAt }
        : {}),
      ...(typeof data.scope === "string" && data.scope ? { scope: data.scope } : {}),
    };
  }

  const consumerKey = (parsed as { consumerKey?: unknown }).consumerKey;
  const consumerSecret = (parsed as { consumerSecret?: unknown }).consumerSecret;
  if (
    typeof consumerKey !== "string" ||
    !consumerKey ||
    typeof consumerSecret !== "string" ||
    !consumerSecret
  ) {
    throw new CatalogProviderError("catalog_credentials_unreadable", 500);
  }
  return { consumerKey, consumerSecret };
}

export async function listCatalogConnections(sellerId: string): Promise<CatalogConnectionSummary[]> {
  const { rows } = await dbQuery<ConnectionSummaryRow>(
    `SELECT id, seller_id, provider, external_account_id, config, status,
            last_sync_at, last_sync_cursor, last_error_code,
            last_customer_sync_at, last_customer_sync_cursor, last_customer_error_code,
            last_order_sync_at, last_order_sync_cursor, last_order_error_code,
            webhook_status, webhook_config, webhooks_updated_at,
            last_reconcile_at, last_reconcile_error_code
       FROM seller_catalog_integrations
      WHERE seller_id = $1
      ORDER BY updated_at DESC, id`,
    [sellerId],
  );
  return rows.map(summary);
}

export async function getCatalogConnection(
  sellerId: string,
  integrationId: string,
): Promise<CatalogConnection | null> {
  const { rows } = await dbQuery<ConnectionRow>(
    `SELECT id, seller_id, provider, external_account_id, credentials_enc, config, status,
            last_sync_at, last_sync_cursor, last_error_code,
            last_customer_sync_at, last_customer_sync_cursor, last_customer_error_code,
            last_order_sync_at, last_order_sync_cursor, last_order_error_code,
            webhook_status, webhook_config, webhooks_updated_at,
            last_reconcile_at, last_reconcile_error_code
       FROM seller_catalog_integrations
      WHERE id = $1 AND seller_id = $2`,
    [integrationId, sellerId],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...summary(row), credentials: decodeCredentials(row) };
}

export async function upsertCatalogConnection(args: {
  sellerId: string;
  provider: CatalogProvider;
  externalAccountId: string;
  credentials: CatalogCredentials;
  config?: Record<string, unknown>;
}): Promise<CatalogConnectionSummary> {
  const key = {
    seller_id: args.sellerId,
    provider: args.provider,
    external_account_id: args.externalAccountId,
  };
  const credentialsEnc = encryptSecret(purpose(key), JSON.stringify(args.credentials));

  try {
    const { rows } = await dbQuery<ConnectionRow>(
      `INSERT INTO seller_catalog_integrations
         (seller_id, provider, external_account_id, credentials_enc, config, status, last_error_code)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'active', NULL)
       ON CONFLICT (seller_id, provider, external_account_id)
       DO UPDATE SET credentials_enc = EXCLUDED.credentials_enc,
                     config = seller_catalog_integrations.config || EXCLUDED.config,
                     status = 'active',
                     last_error_code = NULL,
                     updated_at = now()
       RETURNING id, seller_id, provider, external_account_id, credentials_enc, config, status,
                 last_sync_at, last_sync_cursor, last_error_code,
                 last_customer_sync_at, last_customer_sync_cursor, last_customer_error_code,
                 last_order_sync_at, last_order_sync_cursor, last_order_error_code,
                 webhook_status, webhook_config, webhooks_updated_at,
                 last_reconcile_at, last_reconcile_error_code`,
      [
        args.sellerId,
        args.provider,
        args.externalAccountId,
        credentialsEnc,
        JSON.stringify(args.config ?? {}),
      ],
    );
    return summary(rows[0]);
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") {
      throw new CatalogProviderError("external_store_already_connected", 409);
    }
    throw error;
  }
}

export async function deleteCatalogConnection(
  sellerId: string,
  integrationId: string,
): Promise<boolean> {
  const { rowCount } = await dbQuery(
    `DELETE FROM seller_catalog_integrations
      WHERE id = $1 AND seller_id = $2`,
    [integrationId, sellerId],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteCatalogConnectionById(
  integrationId: string,
): Promise<boolean> {
  const { rowCount } = await dbQuery(
    `DELETE FROM seller_catalog_integrations WHERE id = $1`,
    [integrationId],
  );
  return (rowCount ?? 0) > 0;
}

export async function replaceCatalogCredentials(args: {
  sellerId: string;
  integrationId: string;
  provider: CatalogProvider;
  externalAccountId: string;
  credentials: CatalogCredentials;
}): Promise<void> {
  const credentialsEnc = encryptSecret(
    purpose({
      seller_id: args.sellerId,
      provider: args.provider,
      external_account_id: args.externalAccountId,
    }),
    JSON.stringify(args.credentials),
  );
  const { rowCount } = await dbQuery(
    `UPDATE seller_catalog_integrations
        SET credentials_enc = $5,
            status = 'active',
            last_error_code = NULL,
            updated_at = now()
      WHERE id = $1
        AND seller_id = $2
        AND provider = $3
        AND external_account_id = $4`,
    [
      args.integrationId,
      args.sellerId,
      args.provider,
      args.externalAccountId,
      credentialsEnc,
    ],
  );
  if ((rowCount ?? 0) !== 1) {
    throw new CatalogProviderError("catalog_credentials_update_conflict", 409);
  }
}

export async function getCatalogConnectionById(
  integrationId: string,
): Promise<CatalogConnection | null> {
  const { rows } = await dbQuery<ConnectionRow>(
    `SELECT id, seller_id, provider, external_account_id, credentials_enc, config, status,
            last_sync_at, last_sync_cursor, last_error_code,
            last_customer_sync_at, last_customer_sync_cursor, last_customer_error_code,
            last_order_sync_at, last_order_sync_cursor, last_order_error_code,
            webhook_status, webhook_config, webhooks_updated_at,
            last_reconcile_at, last_reconcile_error_code
       FROM seller_catalog_integrations
      WHERE id = $1`,
    [integrationId],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...summary(row), credentials: decodeCredentials(row) };
}

export async function findCatalogIntegrationByAccount(
  provider: CatalogProvider,
  externalAccountId: string,
): Promise<{ id: string; sellerId: string; webhookSecretEnc: string | null } | null> {
  const { rows } = await dbQuery<{
    id: string;
    seller_id: string;
    webhook_secret_enc: string | null;
  }>(
    `SELECT id, seller_id, webhook_secret_enc
       FROM seller_catalog_integrations
      WHERE provider = $1 AND external_account_id = $2 AND status <> 'disabled'
      LIMIT 1`,
    [provider, externalAccountId],
  );
  const row = rows[0];
  return row
    ? { id: row.id, sellerId: row.seller_id, webhookSecretEnc: row.webhook_secret_enc }
    : null;
}

export async function findCatalogIntegrationForPrivacy(
  provider: CatalogProvider,
  externalAccountId: string,
): Promise<{ id: string; sellerId: string; webhookSecretEnc: string | null } | null> {
  const { rows } = await dbQuery<{
    id: string;
    seller_id: string;
    webhook_secret_enc: string | null;
  }>(
    `SELECT id, seller_id, webhook_secret_enc
       FROM seller_catalog_integrations
      WHERE provider = $1 AND external_account_id = $2
      ORDER BY updated_at DESC
      LIMIT 1`,
    [provider, externalAccountId],
  );
  const row = rows[0];
  return row
    ? { id: row.id, sellerId: row.seller_id, webhookSecretEnc: row.webhook_secret_enc }
    : null;
}

export async function tombstoneShopifyIntegration(args: {
  integrationId: string;
  sellerId: string;
  shop: string;
}): Promise<void> {
  const credentialsEnc = encryptSecret(
    purpose({
      seller_id: args.sellerId,
      provider: "shopify",
      external_account_id: args.shop,
    }),
    JSON.stringify({ accessToken: "revoked" }),
  );
  await dbQuery(
    `UPDATE seller_catalog_integrations
        SET credentials_enc = $4,
            status = 'disabled',
            webhook_status = 'unavailable',
            webhook_config = webhook_config || $5::jsonb,
            updated_at = now()
      WHERE id = $1
        AND seller_id = $2
        AND provider = 'shopify'
        AND external_account_id = $3`,
    [
      args.integrationId,
      args.sellerId,
      args.shop,
      credentialsEnc,
      JSON.stringify({ uninstalledAt: new Date().toISOString() }),
    ],
  );
}

export async function updateWebhookState(args: {
  integrationId: string;
  status: "pending" | "active" | "degraded" | "unavailable";
  config?: Record<string, unknown>;
  encryptedSecret?: string | null;
}): Promise<void> {
  await dbQuery(
    `UPDATE seller_catalog_integrations
        SET webhook_status = $2,
            webhook_config = CASE
              WHEN $3::jsonb IS NULL THEN webhook_config
              ELSE webhook_config || $3::jsonb
            END,
            webhook_secret_enc = COALESCE($4, webhook_secret_enc),
            webhooks_updated_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [
      args.integrationId,
      args.status,
      args.config ? JSON.stringify(args.config) : null,
      args.encryptedSecret ?? null,
    ],
  );
}

export async function markReconcileResult(
  integrationId: string,
  errorCode: string | null,
): Promise<void> {
  await dbQuery(
    `UPDATE seller_catalog_integrations
        SET last_reconcile_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_reconcile_at END,
            last_reconcile_error_code = $2,
            updated_at = now()
      WHERE id = $1`,
    [integrationId, errorCode ? errorCode.slice(0, 120) : null],
  );
}

export async function markCatalogSyncSuccess(
  sellerId: string,
  integrationId: string,
  nextCursor: string | null,
): Promise<void> {
  await dbQuery(
    `UPDATE seller_catalog_integrations
        SET last_sync_at = now(), last_sync_cursor = $3, last_error_code = NULL,
            status = 'active', updated_at = now()
      WHERE id = $1 AND seller_id = $2`,
    [integrationId, sellerId, nextCursor],
  );
}

export async function markCatalogSyncFailure(
  sellerId: string,
  integrationId: string,
  code: string,
): Promise<void> {
  await dbQuery(
    `UPDATE seller_catalog_integrations
        SET last_error_code = $3, status = 'error', updated_at = now()
      WHERE id = $1 AND seller_id = $2`,
    [integrationId, sellerId, code.slice(0, 120)],
  );
}

export async function markCustomerSyncSuccess(
  sellerId: string,
  integrationId: string,
  nextCursor: string | null,
): Promise<void> {
  await dbQuery(
    `UPDATE seller_catalog_integrations
        SET last_customer_sync_at = now(),
            last_customer_sync_cursor = $3,
            last_customer_error_code = NULL,
            updated_at = now()
      WHERE id = $1 AND seller_id = $2`,
    [integrationId, sellerId, nextCursor],
  );
}

export async function markCustomerSyncFailure(
  sellerId: string,
  integrationId: string,
  code: string,
): Promise<void> {
  await dbQuery(
    `UPDATE seller_catalog_integrations
        SET last_customer_error_code = $3, updated_at = now()
      WHERE id = $1 AND seller_id = $2`,
    [integrationId, sellerId, code.slice(0, 120)],
  );
}

export async function markOrderSyncSuccess(
  sellerId: string,
  integrationId: string,
  nextCursor: string | null,
): Promise<void> {
  await dbQuery(
    `UPDATE seller_catalog_integrations
        SET last_order_sync_at = now(),
            last_order_sync_cursor = $3,
            last_order_error_code = NULL,
            updated_at = now()
      WHERE id = $1 AND seller_id = $2`,
    [integrationId, sellerId, nextCursor],
  );
}

export async function markOrderSyncFailure(
  sellerId: string,
  integrationId: string,
  code: string,
): Promise<void> {
  await dbQuery(
    `UPDATE seller_catalog_integrations
        SET last_order_error_code = $3, updated_at = now()
      WHERE id = $1 AND seller_id = $2`,
    [integrationId, sellerId, code.slice(0, 120)],
  );
}
