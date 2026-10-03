import { dbQuery } from "@/lib/db";
import { getTranslations } from "next-intl/server";
import { requireSellerPage } from "@/lib/seller/page-auth";
import { sellerCurrency } from "@/lib/seller/config";
import { RO_VAT_STANDARD_PCT } from "@/lib/seller/invoicing";
import { buildPosCatalog, type PosProductRow, type PosVariantRow } from "@/lib/seller/pos-catalog";
import PosClient from "./PosClient";

export const dynamic = "force-dynamic";

export default async function SellerPosPage() {
  const t = await getTranslations("sellerPos");
  const sellerId = await requireSellerPage("/seller/pos");

  const { rows: products } = await dbQuery<PosProductRow>(
    `SELECT id, title, price_cents, category, image_url, metadata
       FROM marketplace_products
      WHERE seller_id = $1 AND status != 'archived'
      ORDER BY title ASC`,
    [sellerId],
  );
  const { rows: variants } = products.length
    ? await dbQuery<PosVariantRow>(
        `SELECT v.id, v.product_id, v.title, v.sku, v.price_cents, v.inventory_quantity
           FROM marketplace_product_variants v
          WHERE v.product_id = ANY($1::uuid[]) AND v.status IN ('active', 'out_of_stock')
          ORDER BY v.title ASC`,
        [products.map((p) => p.id)],
      )
    : { rows: [] as PosVariantRow[] };

  return (
    <div className="space-y-4 max-w-7xl mx-auto pb-6">
      <div>
        <h1 className="text-xl font-black text-fg">{t("title")}</h1>
        <p className="text-xs text-muted mt-0.5">{t("subtitle")}</p>
      </div>

      <PosClient initialProducts={buildPosCatalog(products, variants)} currency={sellerCurrency()} vatRatePct={RO_VAT_STANDARD_PCT} />
    </div>
  );
}
