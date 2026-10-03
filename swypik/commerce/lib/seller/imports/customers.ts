import { withTransaction, type TxQuery } from "@/lib/db";
import type { CatalogConnection, CustomerPage, ExternalCustomer } from "./types";
import { CatalogProviderError } from "./common";

export type CustomerSyncResult = {
  inspected: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ externalId: string; code: string }>;
};

async function syncCustomer(
  q: TxQuery,
  connection: CatalogConnection,
  customer: ExternalCustomer,
): Promise<"created" | "updated"> {
  const { rows } = await q<{ id: string; inserted: boolean }>(
    `INSERT INTO seller_clients
       (seller_id, name, phone, email, address, city, county, country, postal_code, notes,
        external_source, external_account_id, external_customer_id, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
     ON CONFLICT (seller_id, external_source, external_account_id, external_customer_id)
       WHERE external_source IS NOT NULL
         AND external_account_id IS NOT NULL
         AND external_customer_id IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name,
                   phone = COALESCE(EXCLUDED.phone, seller_clients.phone),
                   email = COALESCE(EXCLUDED.email, seller_clients.email),
                   address = COALESCE(EXCLUDED.address, seller_clients.address),
                   city = COALESCE(EXCLUDED.city, seller_clients.city),
                   county = COALESCE(EXCLUDED.county, seller_clients.county),
                   country = COALESCE(EXCLUDED.country, seller_clients.country),
                   postal_code = COALESCE(EXCLUDED.postal_code, seller_clients.postal_code),
                   notes = COALESCE(EXCLUDED.notes, seller_clients.notes),
                   last_synced_at = now(),
                   updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      connection.sellerId,
      customer.name,
      customer.phone,
      customer.email,
      customer.address,
      customer.city,
      customer.region,
      customer.country,
      customer.postalCode,
      customer.notes,
      connection.provider,
      connection.externalAccountId,
      customer.externalId,
    ],
  );
  const row = rows[0];
  if (!row?.id) throw new CatalogProviderError("customer_sync_failed", 500);
  return row.inserted ? "created" : "updated";
}

export async function syncCustomerPage(
  connection: CatalogConnection,
  page: CustomerPage,
): Promise<CustomerSyncResult> {
  const result: CustomerSyncResult = {
    inspected: page.customers.length,
    created: 0,
    updated: 0,
    failed: 0,
    errors: [],
  };

  for (const customer of page.customers) {
    try {
      const outcome = await withTransaction((q) => syncCustomer(q, connection, customer));
      result[outcome] += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push({
        externalId: customer.externalId,
        code: error instanceof CatalogProviderError ? error.code : "customer_sync_failed",
      });
    }
  }
  return result;
}
