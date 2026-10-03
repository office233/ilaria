/**
 * Meniul unui comerciant.
 *
 * GET   /api/merchants/[id]/menu   → public: categorii + articole disponibile
 * POST  /api/merchants/[id]/menu   → seller adaugă articol sau categorie
 * PATCH /api/merchants/[id]/menu   → seller actualizează articol
 * DELETE /api/merchants/[id]/menu?item_id=  → șterge articol
 */
import { NextResponse } from "next/server";
import { dbQuery, withTransaction } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import {
  MenuCategoryCreateSchema,
  MenuItemCreateSchema,
  MenuItemUpdateSchema,
  parseBody,
} from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";
import { isUuidParam } from "@/lib/validation/params";
import { DEFAULT_CURRENCY } from "@/lib/i18n/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Verifică dacă sellerul logat deține comerciantul. */
async function ownsMerchant(merchantId: string, sellerId: string): Promise<boolean> {
  const { rows } = await dbQuery(
    `SELECT 1 FROM local_merchants WHERE id = $1 AND seller_id = $2`,
    [merchantId, sellerId],
  );
  return rows.length > 0;
}

type MenuItemRow = {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  image_url: string | null;
  options: unknown;
  allergens: string[] | null;
  sort_order: number;
  is_available: boolean;
};

/** Seller logat + proprietar + rate limit; întoarce răspunsul de refuz sau null. */
async function guardOwner(merchantId: string): Promise<NextResponse | null> {
  // Un id non-UUID ajungea în Postgres → 500 (audit food-go #14).
  if (!isUuidParam(merchantId)) {
    return NextResponse.json({ success: false, error: "invalid_id", code: "invalid_id" }, { status: 400 });
  }
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }
  if (!(await ownsMerchant(merchantId, sellerId))) {
    return NextResponse.json({ success: false, error: "Nu e comerciantul tău.", code: "forbidden" }, { status: 403 });
  }
  const rl = await rateLimit("sellerMenu", sellerId);
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited", code: "rate_limited" }, { status: 429 });
  }
  return null;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const { rows: merchants } = await dbQuery<{ id: string; name: string; status: string; seller_id: string | null }>(
      // id e uuid, slug e text -> fara cast, pg nu poate rezolva "$1" pentru ambele (42883 text=uuid)
      `SELECT id, name, status, seller_id FROM local_merchants WHERE id::text = $1 OR slug = $1`,
      [id],
    );
    const merchant = merchants[0];
    // ?all=1 — panoul restaurantului: și articolele indisponibile + categoriile goale
    // (altfel un articol dezactivat dispărea din panou și nu mai putea fi reactivat).
    const wantsAll = new URL(req.url).searchParams.get("all") === "1";
    const sellerId = wantsAll ? await getSellerSessionId() : null;
    const ownerView = !!merchant && !!sellerId && merchant.seller_id === sellerId;
    if (!merchant || (merchant.status !== "active" && !ownerView)) {
      return NextResponse.json({ success: false, error: "Comerciantul nu există." }, { status: 404 });
    }

    const [{ rows: categories }, { rows: items }] = await Promise.all([
      dbQuery<{ id: string; name: string; sort_order: number }>(
        `SELECT id, name, sort_order FROM menu_categories
          WHERE merchant_id = $1 AND is_active ORDER BY sort_order, name`,
        [merchant.id],
      ),
      dbQuery<MenuItemRow>(
        `SELECT id, category_id, name, description, price_cents, currency,
                image_url, options, allergens, sort_order, is_available
           FROM menu_items
          WHERE merchant_id = $1 AND (is_available OR $2::boolean)
          ORDER BY sort_order, name`,
        [merchant.id, ownerView],
      ),
    ]);

    // Grupăm articolele pe categorii; cele fără categorie au id/name null
    // (eticheta „Altele” vine din i18n în client).
    const byCat = new Map<string | null, MenuItemRow[]>();
    const activeCats = new Set(categories.map((c) => c.id));
    for (const it of items) {
      // Articolele dintr-o categorie inactivă/ștearsă nu dispar: merg la „Altele”.
      const k = it.category_id && activeCats.has(it.category_id) ? it.category_id : null;
      if (!byCat.has(k)) byCat.set(k, []);
      byCat.get(k)!.push(it);
    }

    const menu: { id: string | null; name: string | null; items: MenuItemRow[] }[] = categories.map((c) => ({
      id: c.id,
      name: c.name,
      items: byCat.get(c.id) ?? [],
    }));
    const uncategorised = byCat.get(null) ?? [];
    if (uncategorised.length) {
      menu.push({ id: null, name: null, items: uncategorised });
    }

    return NextResponse.json({
      success: true,
      merchant: { id: merchant.id, name: merchant.name },
      menu: ownerView ? menu : menu.filter((c) => c.items.length > 0),
    });
  } catch (error: unknown) {
    logger.error({ err: error }, "[menu] GET error");
    return NextResponse.json({ success: false, error: "Eroare la încărcarea meniului." }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const denied = await guardOwner(id);
    if (denied) return denied;

    const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const body = { ...(raw ?? {}), merchant_id: id };

    // Categorie sau articol? Diferențiem după prezența prețului.
    if (raw && raw.price === undefined && raw.type === "category") {
      const parsed = parseBody(MenuCategoryCreateSchema, body);
      if (!parsed.ok) {
        return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
      }
      const { rows } = await dbQuery(
        `INSERT INTO menu_categories (merchant_id, name, sort_order)
         VALUES ($1, $2, $3) RETURNING id, name, sort_order`,
        [id, parsed.data.name, parsed.data.sort_order ?? 100],
      );
      return NextResponse.json({ success: true, category: rows[0] });
    }

    const parsed = parseBody(MenuItemCreateSchema, body);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }
    const d = parsed.data;

    // Categoria (dacă e dată) trebuie să aparțină aceluiași comerciant.
    if (d.category_id) {
      const { rows: cat } = await dbQuery(
        `SELECT 1 FROM menu_categories WHERE id = $1 AND merchant_id = $2`,
        [d.category_id, id],
      );
      if (!cat.length) {
        return NextResponse.json({ success: false, error: "Categorie invalidă." }, { status: 400 });
      }
    }

    const { rows } = await dbQuery(
      `INSERT INTO menu_items (
         merchant_id, category_id, name, description, price_cents, currency,
         image_url, options, allergens, sort_order
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       RETURNING id, category_id, name, description, price_cents, currency,
                 image_url, options, allergens, is_available, sort_order`,
      [
        id,
        d.category_id ?? null,
        d.name,
        d.description ?? null,
        Math.round(d.price * 100),
        // O singură monedă per comandă: articolele folosesc moneda platformei,
        // nu una aleasă per articol (audit #15 — totalul ignora moneda articolului).
        DEFAULT_CURRENCY,
        d.image_url ?? null,
        JSON.stringify(d.options ?? []),
        d.allergens ?? [],
        d.sort_order ?? 100,
      ],
    );

    return NextResponse.json({ success: true, item: rows[0] });
  } catch (error: unknown) {
    logger.error({ err: error }, "[menu] POST error");
    return NextResponse.json({ success: false, error: "Eroare la salvare." }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const denied = await guardOwner(id);
    if (denied) return denied;

    const raw = await req.json().catch(() => null);
    const parsed = parseBody(MenuItemUpdateSchema, raw);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }
    const { item_id, ...d } = parsed.data;

    const sets: string[] = [];
    const p: unknown[] = [item_id, id];
    const push = (col: string, val: unknown) => {
      p.push(val);
      sets.push(`${col} = $${p.length}`);
    };

    if (d.category_id) {
      const { rows: cat } = await dbQuery(
        `SELECT 1 FROM menu_categories WHERE id = $1 AND merchant_id = $2`,
        [d.category_id, id],
      );
      if (!cat.length) {
        return NextResponse.json({ success: false, error: "invalid_category", code: "invalid_category" }, { status: 400 });
      }
    }
    if (d.category_id !== undefined) push("category_id", d.category_id);
    if (d.name !== undefined) push("name", d.name);
    if (d.description !== undefined) push("description", d.description);
    if (d.price !== undefined) push("price_cents", Math.round(d.price * 100));
    if (d.image_url !== undefined) push("image_url", d.image_url);
    if (d.allergens !== undefined) push("allergens", d.allergens);
    if (d.is_available !== undefined) push("is_available", d.is_available);
    if (d.sort_order !== undefined) push("sort_order", d.sort_order);
    if (d.options !== undefined) {
      p.push(JSON.stringify(d.options));
      sets.push(`options = $${p.length}::jsonb`);
    }

    if (!sets.length) {
      return NextResponse.json({ success: false, error: "Nimic de actualizat." }, { status: 400 });
    }

    const { rows } = await dbQuery(
      `UPDATE menu_items SET ${sets.join(", ")}
        WHERE id = $1 AND merchant_id = $2
        RETURNING id, name, price_cents, is_available`,
      p,
    );
    if (!rows.length) {
      return NextResponse.json({ success: false, error: "Articolul nu există." }, { status: 404 });
    }
    return NextResponse.json({ success: true, item: rows[0] });
  } catch (error: unknown) {
    logger.error({ err: error }, "[menu] PATCH error");
    return NextResponse.json({ success: false, error: "Eroare la actualizare." }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const denied = await guardOwner(id);
    if (denied) return denied;

    const url = new URL(req.url);
    const itemId = url.searchParams.get("item_id");
    const categoryId = url.searchParams.get("category_id");

    if ((itemId && !isUuidParam(itemId)) || (categoryId && !isUuidParam(categoryId))) {
      return NextResponse.json({ success: false, error: "invalid_id", code: "invalid_id" }, { status: 400 });
    }
    if (itemId) {
      const { rowCount } = await dbQuery(
        `DELETE FROM menu_items WHERE id = $1 AND merchant_id = $2`,
        [itemId, id],
      );
      return NextResponse.json({ success: rowCount > 0 });
    }
    if (categoryId) {
      // Articolele rămân, dar fără categorie (ON DELETE SET NULL în schemă).
      const { rowCount } = await withTransaction(async (q) =>
        q(`DELETE FROM menu_categories WHERE id = $1 AND merchant_id = $2`, [categoryId, id]),
      );
      return NextResponse.json({ success: rowCount > 0 });
    }
    return NextResponse.json({ success: false, error: "item_id sau category_id lipsă." }, { status: 400 });
  } catch (error: unknown) {
    logger.error({ err: error }, "[menu] DELETE error");
    return NextResponse.json({ success: false, error: "Eroare la ștergere." }, { status: 500 });
  }
}
