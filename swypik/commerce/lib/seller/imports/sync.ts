import { withTransaction, type TxQuery } from "@/lib/db";
import { createHash } from "node:crypto";
import { slugify } from "@/lib/merchants/slug";
import { autoEmbedProduct } from "@/lib/ai/auto-embed";
import { labelProduct } from "@/lib/moderation/labelProduct";
import type {
  CatalogConnection,
  CatalogPage,
  ExternalCatalogProduct,
  ExternalCatalogVariant,
} from "./types";
import { CatalogProviderError } from "./common";

type ExistingProduct = {
  id: string;
  seller_id: string | null;
};

export type CatalogSyncResult = {
  inspected: number;
  created: number;
  updated: number;
  failed: number;
  dryRun: boolean;
  errors: Array<{ externalId: string; code: string }>;
};

function importStatus(product: ExternalCatalogProduct): ExternalCatalogProduct["status"] {
  if (product.status === "archived") return "archived";
  if (product.status === "active" && product.priceCents > 0 && product.variantsComplete) return "active";
  return "draft";
}

function importedProductSlug(connection: CatalogConnection, product: ExternalCatalogProduct): string {
  const suffix = createHash("sha256")
    .update(`${connection.provider}:${connection.externalAccountId}:${product.externalId}`)
    .digest("hex")
    .slice(0, 10);
  return `${slugify(product.title) || "product"}-${suffix}`;
}

function productMetadata(connection: CatalogConnection, product: ExternalCatalogProduct) {
  return {
    seller_id: connection.sellerId,
    source_provider: connection.provider,
    external_account_id: connection.externalAccountId,
    external_product_id: product.externalId,
    available_stock: product.inventoryQuantity,
    image_urls: product.imageUrls,
    import: product.metadata,
  };
}

async function syncVariants(
  q: TxQuery,
  productId: string,
  provider: string,
  currency: string,
  variants: ExternalCatalogVariant[],
  complete: boolean,
): Promise<void> {
  const externalIds: string[] = [];

  for (const variant of variants) {
    externalIds.push(variant.externalId);
    const status = variant.inventoryStatus === "out_of_stock" ? "out_of_stock" : "active";
    await q(
      `INSERT INTO marketplace_product_variants
         (product_id, external_variant_id, sku, title, attributes, currency,
          price_cents, inventory_quantity, status, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (product_id, external_variant_id)
         WHERE external_variant_id IS NOT NULL
       DO UPDATE SET sku = EXCLUDED.sku,
                     title = EXCLUDED.title,
                     attributes = EXCLUDED.attributes,
                     currency = EXCLUDED.currency,
                     price_cents = EXCLUDED.price_cents,
                     inventory_quantity = EXCLUDED.inventory_quantity,
                     status = EXCLUDED.status,
                     metadata = marketplace_product_variants.metadata || EXCLUDED.metadata,
                     updated_at = now()`,
      [
        productId,
        variant.externalId,
        variant.sku,
        variant.title,
        JSON.stringify(variant.attributes),
        currency,
        variant.priceCents,
        variant.inventoryQuantity,
        status,
        JSON.stringify({
          source_provider: provider,
          compare_at_price_cents: variant.compareAtPriceCents,
        }),
      ],
    );
  }

  if (complete) {
    await q(
      `UPDATE marketplace_product_variants
          SET status = 'archived', updated_at = now()
        WHERE product_id = $1
          AND external_variant_id IS NOT NULL
          AND NOT (external_variant_id = ANY($2::text[]))`,
      [productId, externalIds],
    );
  }
}

async function syncOne(
  connection: CatalogConnection,
  product: ExternalCatalogProduct,
): Promise<"created" | "updated"> {
  const synced = await withTransaction(async (q) => {
    const { rows } = await q<ExistingProduct>(
      `SELECT id, seller_id
         FROM marketplace_products
        WHERE source_type = $1 AND supplier = $2 AND supplier_product_id = $3
        FOR UPDATE`,
      [connection.provider, connection.externalAccountId, product.externalId],
    );
    const existing = rows[0];
    if (existing && existing.seller_id !== connection.sellerId) {
      throw new CatalogProviderError("external_product_owned_by_another_seller", 409);
    }

    const status = importStatus(product);
    const compareAt =
      product.compareAtPriceCents != null && product.compareAtPriceCents >= product.priceCents
        ? product.compareAtPriceCents
        : null;
    const metadata = JSON.stringify(productMetadata(connection, product));

    let productId: string;
    let outcome: "created" | "updated";

    if (existing) {
      const updated = await q<{ id: string }>(
        `UPDATE marketplace_products
            SET title = $4,
                description = $5,
                brand = $6,
                price_cents = $7,
                compare_at_price_cents = $8,
                category = $9,
                currency = $10,
                status = $11,
                inventory_status = $12,
                image_url = $13,
                supplier_url = $14,
                metadata = metadata || $15::jsonb,
                updated_at = now()
          WHERE id = $1 AND seller_id = $2 AND source_type = $3
          RETURNING id`,
        [
          existing.id,
          connection.sellerId,
          connection.provider,
          product.title,
          product.description,
          product.brand,
          product.priceCents,
          compareAt,
          product.category ?? "General",
          product.currency,
          status,
          product.inventoryStatus,
          product.imageUrls[0] ?? null,
          product.sourceUrl,
          metadata,
        ],
      );
      if (!updated.rows[0]) throw new CatalogProviderError("catalog_product_update_conflict", 409);
      productId = updated.rows[0].id;
      outcome = "updated";
    } else {
      const inserted = await q<{ id: string }>(
        `INSERT INTO marketplace_products
           (source_type, seller_id, title, slug, description, brand,
            price_cents, compare_at_price_cents, category, currency, status,
            inventory_status, image_url, supplier, supplier_product_id, supplier_url, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)
         RETURNING id`,
        [
          connection.provider,
          connection.sellerId,
          product.title,
          importedProductSlug(connection, product),
          product.description,
          product.brand,
          product.priceCents,
          compareAt,
          product.category ?? "General",
          product.currency,
          status,
          product.inventoryStatus,
          product.imageUrls[0] ?? null,
          connection.externalAccountId,
          product.externalId,
          product.sourceUrl,
          metadata,
        ],
      );
      productId = inserted.rows[0].id;
      outcome = "created";
    }

    await syncVariants(
      q,
      productId,
      connection.provider,
      product.currency,
      product.variants,
      product.variantsComplete,
    );
    return { outcome, productId };
  });

  // Keep imported products on the same discovery/safety path as products
  // created manually in /api/seller/products. labelProduct is fail-soft by
  // contract; embeddings are fire-and-forget when the provider is configured.
  await labelProduct({
    id: synced.productId,
    title: product.title,
    description: product.description,
    category: product.category,
  });
  autoEmbedProduct(synced.productId, product.title, product.description);
  return synced.outcome;
}

export async function syncCatalogPage(
  connection: CatalogConnection,
  page: CatalogPage,
  dryRun = false,
): Promise<CatalogSyncResult> {
  const result: CatalogSyncResult = {
    inspected: page.products.length,
    created: 0,
    updated: 0,
    failed: 0,
    dryRun,
    errors: [],
  };
  if (dryRun) return result;

  for (const product of page.products) {
    try {
      const outcome = await syncOne(connection, product);
      result[outcome] += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push({
        externalId: product.externalId,
        code: error instanceof CatalogProviderError ? error.code : "catalog_product_sync_failed",
      });
    }
  }
  return result;
}

export async function archiveExternalProduct(
  connection: CatalogConnection,
  externalId: string,
): Promise<void> {
  await withTransaction(async (q) => {
    const { rows } = await q<{ id: string }>(
      `UPDATE marketplace_products
          SET status = 'archived', inventory_status = 'out_of_stock', updated_at = now()
        WHERE seller_id = $1
          AND source_type = $2
          AND supplier = $3
          AND supplier_product_id = $4
        RETURNING id`,
      [connection.sellerId, connection.provider, connection.externalAccountId, externalId],
    );
    const productId = rows[0]?.id;
    if (!productId) return;
    await q(
      `UPDATE marketplace_product_variants
          SET status = 'archived', updated_at = now()
        WHERE product_id = $1 AND status <> 'archived'`,
      [productId],
    );
  });
}
