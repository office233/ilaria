import { dbQuery, withTransaction } from "@/lib/db";
import type { CatalogProvider } from "./types";
import type { WebhookAction, WebhookResource } from "./webhook-topic";

export type IntegrationWebhookEvent = {
  id: string;
  integrationId: string;
  provider: CatalogProvider;
  deliveryId: string;
  topic: string;
  resource: WebhookResource;
  action: WebhookAction;
  externalResourceId: string | null;
  attempts: number;
};

export async function enqueueWebhookEvent(args: {
  integrationId: string;
  provider: CatalogProvider;
  deliveryId: string;
  topic: string;
  resource: WebhookResource;
  action: WebhookAction;
  externalResourceId: string | null;
  payloadSha256: string;
  triggeredAt?: string | null;
}): Promise<boolean> {
  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO seller_integration_webhook_events
       (integration_id, provider, delivery_id, topic, resource, action,
        external_resource_id, payload_sha256, triggered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
     ON CONFLICT (integration_id, provider, delivery_id) DO NOTHING
     RETURNING id`,
    [
      args.integrationId,
      args.provider,
      args.deliveryId,
      args.topic,
      args.resource,
      args.action,
      args.externalResourceId,
      args.payloadSha256,
      args.triggeredAt ?? null,
    ],
  );
  return Boolean(rows[0]);
}

export async function claimWebhookEvents(
  workerId: string,
  limit: number,
): Promise<IntegrationWebhookEvent[]> {
  return withTransaction(async (q) => {
    const { rows } = await q<{
      id: string;
      integration_id: string;
      provider: CatalogProvider;
      delivery_id: string;
      topic: string;
      resource: WebhookResource;
      action: WebhookAction;
      external_resource_id: string | null;
      attempts: number;
    }>(
      `WITH candidates AS (
         SELECT id
           FROM seller_integration_webhook_events
          WHERE (
                  (
                    status IN ('pending', 'failed')
                    AND next_attempt_at <= now()
                  )
                  OR (
                    status = 'processing'
                    AND lease_expires_at IS NOT NULL
                    AND lease_expires_at < now()
                  )
                )
            AND attempts < 8
          ORDER BY received_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE seller_integration_webhook_events e
          SET status = 'processing',
              attempts = e.attempts + 1,
              locked_by = $2,
              lease_expires_at = now() + interval '5 minutes',
              last_error_code = NULL
         FROM candidates c
        WHERE e.id = c.id
       RETURNING e.id, e.integration_id, e.provider, e.delivery_id, e.topic,
                 e.resource, e.action, e.external_resource_id, e.attempts`,
      [limit, workerId],
    );
    return rows.map((row) => ({
      id: row.id,
      integrationId: row.integration_id,
      provider: row.provider,
      deliveryId: row.delivery_id,
      topic: row.topic,
      resource: row.resource,
      action: row.action,
      externalResourceId: row.external_resource_id,
      attempts: row.attempts,
    }));
  });
}

export async function completeWebhookEvent(id: string): Promise<void> {
  await dbQuery(
    `UPDATE seller_integration_webhook_events
        SET status = 'done',
            processed_at = now(),
            locked_by = NULL,
            lease_expires_at = NULL,
            last_error_code = NULL
      WHERE id = $1`,
    [id],
  );
}

export async function failWebhookEvent(
  id: string,
  attempts: number,
  errorCode: string,
): Promise<void> {
  const backoffSeconds = Math.min(3600, Math.max(30, 30 * 2 ** Math.max(0, attempts - 1)));
  await dbQuery(
    `UPDATE seller_integration_webhook_events
        SET status = 'failed',
            next_attempt_at = now() + ($2::int * interval '1 second'),
            locked_by = NULL,
            lease_expires_at = NULL,
            last_error_code = $3
      WHERE id = $1`,
    [id, backoffSeconds, errorCode.slice(0, 120)],
  );
}

export async function webhookQueueStats(): Promise<{
  pending: number;
  failed: number;
  processing: number;
}> {
  const { rows } = await dbQuery<{ pending: number; failed: number; processing: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE status = 'processing')::int AS processing
     FROM seller_integration_webhook_events`,
  );
  return rows[0] ?? { pending: 0, failed: 0, processing: 0 };
}
