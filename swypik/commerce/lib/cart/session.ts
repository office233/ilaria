/**
 * Cart session helper — resolves the active cart for a request.
 *
 * Logic:
 *  - If user is authed (swypik_session cookie), use carts.user_id.
 *  - Else, use cookie 'swypik_cart_token' which maps to carts.external_cart_id.
 *  - Creates an active cart row if none exists.
 */
import { getShopConfig } from "@/lib/shop/config";
import { cookies } from "next/headers";
import crypto from "crypto";
import { dbQuery } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/getAuthUser";

export const CART_COOKIE = "swypik_cart_token";
const CART_TOKEN_MAX_AGE = 60 * 60 * 24 * 30;
const isProd = process.env.NODE_ENV === "production";

export type ActiveCart = {
  cartId: string;
  userId: string | null;
  anonToken: string | null;
  currency: string;
};

export async function getOrCreateCart(opts: { create?: boolean } = {}): Promise<ActiveCart | null> {
  const auth = await getAuthUser().catch(() => null);
  const userId = auth?.userId ?? null;
  const store = await cookies();
  const anonToken = store.get(CART_COOKIE)?.value || null;

  if (userId) {
    const { rows } = await dbQuery<{ id: string; currency: string }>(
      `SELECT id, currency FROM carts WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    if (rows[0]) return { cartId: rows[0].id, userId, anonToken, currency: rows[0].currency };
    if (!opts.create) return null;
    const ins = await dbQuery<{ id: string; currency: string }>(
      `INSERT INTO carts (user_id, status, currency) VALUES ($1, 'active', 'RON') RETURNING id, currency`,
      [userId],
    );
    return { cartId: ins.rows[0].id, userId, anonToken, currency: ins.rows[0].currency };
  }

  if (anonToken) {
    const { rows } = await dbQuery<{ id: string; currency: string }>(
      `SELECT id, currency FROM carts WHERE external_cart_id = $1 AND status = 'active' LIMIT 1`,
      [anonToken],
    );
    if (rows[0]) return { cartId: rows[0].id, userId: null, anonToken, currency: rows[0].currency };
  }

  if (!opts.create) return null;
  const newToken = anonToken || crypto.randomBytes(24).toString("hex");
  const ins = await dbQuery<{ id: string; currency: string }>(
    `INSERT INTO carts (external_cart_id, status, currency) VALUES ($1, 'active', 'RON')
     ON CONFLICT (external_cart_id) DO UPDATE SET updated_at = now()
     RETURNING id, currency`,
    [newToken],
  );
  return { cartId: ins.rows[0].id, userId: null, anonToken: newToken, currency: ins.rows[0].currency };
}

export function buildCartCookie(token: string): string {
  return `${CART_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CART_TOKEN_MAX_AGE}${isProd ? "; Secure" : ""}`;
}

/** Move all rows of anonCart into userCart, then delete anonCart. */
export async function mergeAnonCartToUser(anonToken: string, userId: string): Promise<void> {
  if (!anonToken || !userId) return;
  const { rows: anonRows } = await dbQuery<{ id: string }>(
    `SELECT id FROM carts WHERE external_cart_id = $1 AND status = 'active' LIMIT 1`,
    [anonToken],
  );
  if (!anonRows[0]) return;
  const anonCartId = anonRows[0].id;

  let userCartId: string;
  const { rows: userRows } = await dbQuery<{ id: string }>(
    `SELECT id FROM carts WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (userRows[0]) {
    userCartId = userRows[0].id;
  } else {
    const ins = await dbQuery<{ id: string }>(
      `INSERT INTO carts (user_id, status, currency) VALUES ($1, 'active', 'RON') RETURNING id`,
      [userId],
    );
    userCartId = ins.rows[0].id;
  }

  // Move items; on unique conflict (same external_product+variant w/ mergeable=true), sum quantities.
  const { rows: items } = await dbQuery<{
    id: string;
    external_product_id: string;
    external_variant_id: string | null;
    title: string;
    quantity: number;
    currency: string;
    unit_amount_cents: number;
    metadata: { mergeable?: boolean } | null;
  }>(
    `SELECT id, external_product_id, external_variant_id, title, quantity, currency, unit_amount_cents, metadata
     FROM cart_items WHERE cart_id = $1`,
    [anonCartId],
  );
  // Aceeași limită pe linie ca în coș/checkout (SHOP_MAX_LINE_QTY): o linie
  // unită peste limită făcea checkout-ul să pice cu `invalid_quantity`.
  const maxQty = getShopConfig().maxLineQty;
  for (const it of items) {
    const mergeable = it.metadata?.mergeable === true;
    if (mergeable) {
      const { rowCount } = await dbQuery(
        `UPDATE cart_items SET quantity = LEAST(quantity + $1, $5), updated_at = now()
         WHERE cart_id = $2 AND external_product_id = $3
           AND COALESCE(external_variant_id,'') = COALESCE($4,'')
           AND (metadata->>'mergeable') = 'true'`,
        [it.quantity, userCartId, it.external_product_id, it.external_variant_id, maxQty],
      );
      if (rowCount && rowCount > 0) {
        await dbQuery(`DELETE FROM cart_items WHERE id = $1`, [it.id]);
        continue;
      }
    }
    await dbQuery(`UPDATE cart_items SET cart_id = $1, quantity = LEAST(quantity, $3) WHERE id = $2`, [
      userCartId,
      it.id,
      maxQty,
    ]);
  }
  await dbQuery(`DELETE FROM carts WHERE id = $1`, [anonCartId]);
}
