import { NextResponse } from "next/server";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { withErrorHandling } from "@/lib/api-handler";
import { VIRAL_PRODUCTS } from "@/lib/seller/viral-catalog.seed";

export const dynamic = "force-dynamic";

/** Stoc declarat pentru produse livrate la cerere de furnizor (nu e stoc propriu). */
const ONDEMAND_DECLARED_STOCK = 100;

const ImportSchema = z.object({
  viralId: z.string().trim().min(1).max(64),
  customPriceRon: z.coerce.number().positive().max(1_000_000).optional(),
});

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const POST = withErrorHandling(async function POST(req: Request) {
  if (!isEnabled("viralCatalog")) return frozenResponse("viralCatalog");

  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimit("sellerProducts", sellerId);
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  const parsed = parseBody(ImportSchema, await req.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  }
  const seed = VIRAL_PRODUCTS.find((p) => p.id === parsed.data.viralId);
  if (!seed) {
    return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
  }

  const retailPriceRon = parsed.data.customPriceRon ?? seed.recommendedPriceRon;
  const slug = `${slugify(seed.title)}-${Date.now().toString(36)}`;
  const meta = {
    seller_id: sellerId,
    available_stock: ONDEMAND_DECLARED_STOCK,
    is_ondemand_fulfillment: true,
    sku: seed.sku,
    barcode: seed.barcode,
    video_url: seed.videoUrl,
    image_urls: [seed.imageUrl],
    source: "viral_catalog_seed",
  };

  // Produs + video + legaturi intr-o singura tranzactie. Videoclipul intra in
  // moderare (pending_review) ca orice alt upload - versiunea anterioara il
  // marca direct effective_label='safe', ocolind clasificatorul.
  const result = await withTransaction(async (q) => {
    const { rows: sellerRows } = await q<{ user_id: string | null }>(
      `SELECT user_id FROM sellers WHERE id = $1`,
      [sellerId],
    );
    const sellerUserId = sellerRows[0]?.user_id ?? null;

    const { rows: productRows } = await q<{ id: string }>(
      `INSERT INTO marketplace_products (
         source_type, seller_id, title, slug, description, price_cents, supplier_cost_cents,
         category, currency, status, inventory_status, image_url, metadata
       ) VALUES ('seller', $1, $2, $3, $4, $5, $6, $7, 'RON', 'active', 'in_stock', $8, $9::jsonb)
       RETURNING id`,
      [
        sellerId, seed.title, slug, seed.description,
        Math.round(retailPriceRon * 100), Math.round(seed.wholesaleCostRon * 100),
        seed.category, seed.imageUrl, JSON.stringify(meta),
      ],
    );
    const productId = productRows[0].id;

    if (!sellerUserId) return { productId, videoId: null as string | null };

    const { rows: videoRows } = await q<{ id: string }>(
      `INSERT INTO videos (creator_id, playback_url, thumbnail_url, title, description, status, visibility, moderation_status)
       VALUES ($1, $2, $3, $4, $5, 'ready', 'public', 'pending_review')
       RETURNING id`,
      [sellerUserId, seed.videoUrl, seed.imageUrl, seed.title, seed.description],
    );
    const videoId = videoRows[0].id;
    await q(
      `INSERT INTO video_product_links (video_id, product_id, placement, sort_order, metadata)
       VALUES ($1, $2, 'card', 0, '{}'::jsonb)`,
      [videoId, productId],
    );
    await q(
      `INSERT INTO creator_product_links (creator_id, product_id, status) VALUES ($1, $2, 'active')`,
      [sellerUserId, productId],
    );
    return { productId, videoId };
  });

  return NextResponse.json({ success: true, ...result }, { status: 201 });
});
