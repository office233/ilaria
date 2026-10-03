import { hostname } from "node:os";
import { dbQuery, withAdvisoryLock } from "@/lib/db";
import { intEnv } from "@/lib/config/env";
import { logger } from "@/lib/logger";
import {
  getCatalogConnectionById,
  markCatalogSyncFailure,
  markCatalogSyncSuccess,
  markCustomerSyncFailure,
  markCustomerSyncSuccess,
  markOrderSyncFailure,
  markOrderSyncSuccess,
  markReconcileResult,
} from "./connections";
import {
  fetchCatalogPage,
  fetchCustomerById,
  fetchCustomerPage,
  fetchOrderById,
  fetchOrderPage,
  fetchProductById,
} from "./provider";
import { syncCustomerPage } from "./customers";
import { syncOrderPage } from "./orders";
import { archiveExternalProduct, syncCatalogPage } from "./sync";
import {
  claimWebhookEvents,
  completeWebhookEvent,
  failWebhookEvent,
  webhookQueueStats,
  type IntegrationWebhookEvent,
} from "./webhook-events";
import { ensureIntegrationWebhooks } from "./webhooks";
import { CatalogProviderError } from "./common";
import { cleanupExpiredShopifyOAuthStates } from "./shopify-oauth";

function errorCode(error: unknown): string {
  if (error instanceof CatalogProviderError) return error.code;
  if (error instanceof Error && error.message) return error.message.slice(0, 120);
  return "integration_sync_failed";
}

export async function processIntegrationWebhookEvent(event: IntegrationWebhookEvent): Promise<void> {
  const connection = await getCatalogConnectionById(event.integrationId);
  if (!connection || connection.status === "disabled") return;
  const externalId = event.externalResourceId;
  if (!externalId) throw new Error("webhook_resource_id_missing");

  const args = {
    externalAccountId: connection.externalAccountId,
    credentials: connection.credentials,
    sellerId: connection.sellerId,
    integrationId: connection.id,
  };

  if (event.resource === "product") {
    await withAdvisoryLock(`seller-catalog-sync:${connection.id}`, async () => {
      const product = await fetchProductById(connection.provider, args, externalId);
      if (!product) {
        await archiveExternalProduct(connection, externalId);
        return;
      }
      const result = await syncCatalogPage(connection, {
        products: [product],
        nextCursor: null,
        storeCurrency: product.currency,
      });
      if (result.failed > 0) throw new Error(result.errors[0]?.code || "catalog_product_sync_failed");
    });
    return;
  }

  if (event.resource === "customer") {
    await withAdvisoryLock(`seller-crm-sync:${connection.id}`, async () => {
      const customer = await fetchCustomerById(connection.provider, args, externalId);
      if (!customer) return; // keep historical CRM row when the remote customer was deleted
      const result = await syncCustomerPage(connection, { customers: [customer], nextCursor: null });
      if (result.failed > 0) throw new Error(result.errors[0]?.code || "customer_sync_failed");
    });
    return;
  }

  await withAdvisoryLock(`seller-order-history-sync:${connection.id}`, async () => {
    const order = await fetchOrderById(connection.provider, args, externalId);
    if (!order) return; // historical orders remain immutable evidence after remote deletion
    const result = await syncOrderPage(connection, { orders: [order], nextCursor: null });
    if (result.failed > 0) throw new Error(result.errors[0]?.code || "order_sync_failed");
  });
}

export async function runWebhookEventJobs(): Promise<{
  claimed: number;
  completed: number;
  failed: number;
}> {
  const limit = intEnv("SELLER_WEBHOOK_JOBS_PER_RUN", 30, 1, 200);
  const workerId = `${hostname()}:${process.pid}`;
  const events = await claimWebhookEvents(workerId, limit);
  let completed = 0;
  let failed = 0;
  for (const event of events) {
    try {
      await processIntegrationWebhookEvent(event);
      await completeWebhookEvent(event.id);
      completed += 1;
    } catch (error) {
      failed += 1;
      const code = errorCode(error);
      await failWebhookEvent(event.id, event.attempts, code);
      logger.warn(
        { err: error, eventId: event.id, integrationId: event.integrationId, resource: event.resource },
        "[seller-integrations] webhook event failed",
      );
    }
  }
  return { claimed: events.length, completed, failed };
}

async function staleWebhookIntegrationIds(): Promise<string[]> {
  const limit = intEnv("SELLER_WEBHOOK_SETUP_PER_RUN", 2, 1, 20);
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT id
       FROM seller_catalog_integrations
      WHERE status = 'active'
        AND (
          webhook_status <> 'active'
          OR webhooks_updated_at IS NULL
          OR webhooks_updated_at < now() - interval '24 hours'
        )
      ORDER BY webhooks_updated_at NULLS FIRST, updated_at
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.id);
}

export async function repairIntegrationWebhooks(): Promise<{
  inspected: number;
  active: number;
  degraded: number;
  unavailable: number;
}> {
  const ids = await staleWebhookIntegrationIds();
  let active = 0;
  let degraded = 0;
  let unavailable = 0;
  for (const id of ids) {
    const connection = await getCatalogConnectionById(id);
    if (!connection || connection.status !== "active") continue;
    try {
      const result = await ensureIntegrationWebhooks(connection);
      if (result.status === "active") active += 1;
      else if (result.status === "degraded") degraded += 1;
      else unavailable += 1;
    } catch (error) {
      degraded += 1;
      await dbQuery(
        `UPDATE seller_catalog_integrations
            SET webhook_status = 'degraded',
                webhook_config = webhook_config || $2::jsonb,
                webhooks_updated_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [id, JSON.stringify({ last_setup_error: errorCode(error) })],
      ).catch(() => undefined);
      logger.warn({ err: error, integrationId: id }, "[seller-integrations] webhook repair failed");
    }
  }
  return { inspected: ids.length, active, degraded, unavailable };
}

type ReconcileTarget = { id: string; resource: "product" | "customer" | "order" };

async function dueReconcileTargets(): Promise<ReconcileTarget[]> {
  const limit = intEnv("SELLER_RECONCILE_INTEGRATIONS_PER_RUN", 2, 1, 20);
  const hours = intEnv("SELLER_RECONCILE_INTERVAL_HOURS", 6, 1, 168);
  const { rows } = await dbQuery<{
    id: string;
    resource: "product" | "customer" | "order";
  }>(
    `SELECT id,
            CASE
              WHEN last_sync_cursor IS NOT NULL THEN 'product'
              WHEN last_customer_sync_cursor IS NOT NULL THEN 'customer'
              WHEN last_order_sync_cursor IS NOT NULL THEN 'order'
              WHEN COALESCE(last_sync_at, 'epoch'::timestamptz)
                   <= LEAST(
                     COALESCE(last_customer_sync_at, 'epoch'::timestamptz),
                     COALESCE(last_order_sync_at, 'epoch'::timestamptz)
                   ) THEN 'product'
              WHEN COALESCE(last_customer_sync_at, 'epoch'::timestamptz)
                   <= COALESCE(last_order_sync_at, 'epoch'::timestamptz) THEN 'customer'
              ELSE 'order'
            END AS resource
       FROM seller_catalog_integrations
      WHERE status = 'active'
        AND (
          last_sync_cursor IS NOT NULL
          OR last_customer_sync_cursor IS NOT NULL
          OR last_order_sync_cursor IS NOT NULL
          OR LEAST(
               COALESCE(last_sync_at, 'epoch'::timestamptz),
               COALESCE(last_customer_sync_at, 'epoch'::timestamptz),
               COALESCE(last_order_sync_at, 'epoch'::timestamptz)
             ) < now() - ($1::int * interval '1 hour')
        )
      ORDER BY
        CASE WHEN config ? 'bootstrapRequestedAt' THEN 0 ELSE 1 END,
        LEAST(
        COALESCE(last_sync_at, 'epoch'::timestamptz),
        COALESCE(last_customer_sync_at, 'epoch'::timestamptz),
        COALESCE(last_order_sync_at, 'epoch'::timestamptz)
        ),
        id
      LIMIT $2`,
    [hours, limit],
  );
  return rows;
}

async function reconcileResource(
  integrationId: string,
  resource: ReconcileTarget["resource"],
): Promise<boolean> {
  const connection = await getCatalogConnectionById(integrationId);
  if (!connection || connection.status !== "active") return true;
  const maxPages = intEnv("SELLER_RECONCILE_MAX_PAGES_PER_RUN", 3, 1, 20);
  const pageSize = intEnv("SELLER_RECONCILE_PAGE_SIZE", 50, 1, 50);
  let cursor =
    resource === "product"
      ? connection.lastSyncCursor
      : resource === "customer"
        ? connection.lastCustomerSyncCursor
        : connection.lastOrderSyncCursor;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    if (resource === "product") {
      const page = await fetchCatalogPage(connection.provider, {
        externalAccountId: connection.externalAccountId,
        credentials: connection.credentials,
        sellerId: connection.sellerId,
        integrationId: connection.id,
        cursor,
        limit: pageSize,
      });
      const result = await withAdvisoryLock(
        `seller-catalog-sync:${connection.id}`,
        () => syncCatalogPage(connection, page),
      );
      if (result.failed > 0) {
        const code = result.errors[0]?.code || "catalog_reconcile_failed";
        await markCatalogSyncFailure(connection.sellerId, connection.id, code);
        throw new Error(code);
      }
      cursor = page.nextCursor;
      await markCatalogSyncSuccess(connection.sellerId, connection.id, cursor);
    } else if (resource === "customer") {
      const page = await fetchCustomerPage(connection.provider, {
        externalAccountId: connection.externalAccountId,
        credentials: connection.credentials,
        sellerId: connection.sellerId,
        integrationId: connection.id,
        cursor,
        limit: pageSize,
      });
      const result = await withAdvisoryLock(
        `seller-crm-sync:${connection.id}`,
        () => syncCustomerPage(connection, page),
      );
      if (result.failed > 0) {
        const code = result.errors[0]?.code || "customer_reconcile_failed";
        await markCustomerSyncFailure(connection.sellerId, connection.id, code);
        throw new Error(code);
      }
      cursor = page.nextCursor;
      await markCustomerSyncSuccess(connection.sellerId, connection.id, cursor);
    } else {
      const page = await fetchOrderPage(connection.provider, {
        externalAccountId: connection.externalAccountId,
        credentials: connection.credentials,
        sellerId: connection.sellerId,
        integrationId: connection.id,
        cursor,
        limit: pageSize,
      });
      const result = await withAdvisoryLock(
        `seller-order-history-sync:${connection.id}`,
        () => syncOrderPage(connection, page),
      );
      if (result.failed > 0) {
        const code = result.errors[0]?.code || "order_reconcile_failed";
        await markOrderSyncFailure(connection.sellerId, connection.id, code);
        throw new Error(code);
      }
      cursor = page.nextCursor;
      await markOrderSyncSuccess(connection.sellerId, connection.id, cursor);
    }

    if (!cursor) {
      await markReconcileResult(connection.id, null);
      await dbQuery(
        `UPDATE seller_catalog_integrations
            SET config = config - 'bootstrapRequestedAt',
                updated_at = now()
          WHERE id = $1
            AND last_sync_at IS NOT NULL
            AND last_customer_sync_at IS NOT NULL
            AND last_order_sync_at IS NOT NULL
            AND last_sync_cursor IS NULL
            AND last_customer_sync_cursor IS NULL
            AND last_order_sync_cursor IS NULL`,
        [connection.id],
      );
      return true;
    }
  }
  return false;
}

export async function reconcileSellerIntegrations(): Promise<{
  inspected: number;
  completed: number;
  partial: number;
  failed: number;
}> {
  const targets = await dueReconcileTargets();
  let completed = 0;
  let partial = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      const done = await reconcileResource(target.id, target.resource);
      if (done) completed += 1;
      else partial += 1;
    } catch (error) {
      failed += 1;
      await markReconcileResult(target.id, errorCode(error)).catch(() => undefined);
      logger.warn(
        { err: error, integrationId: target.id, resource: target.resource },
        "[seller-integrations] reconcile failed",
      );
    }
  }
  return { inspected: targets.length, completed, partial, failed };
}

export async function runSellerIntegrationMaintenance() {
  const [events, webhookRepair, expiredOAuthStates] = await Promise.all([
    runWebhookEventJobs(),
    repairIntegrationWebhooks(),
    cleanupExpiredShopifyOAuthStates(),
  ]);
  const reconcile = await reconcileSellerIntegrations();
  return {
    events,
    webhookRepair,
    expiredOAuthStates,
    reconcile,
    queue: await webhookQueueStats(),
  };
}
