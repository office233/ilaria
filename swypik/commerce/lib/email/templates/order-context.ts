/**
 * Contextul unei comenzi pentru emailuri: limba cumpărătorului și linkul pe
 * care ACEL destinatar îl poate deschide.
 *
 *  - `/orders/<order_lookup_token>` merge pentru oricine are emailul (și
 *    pentru comenzile fără cont) — varianta preferată;
 *  - fără token, dar cu cont: `/account/orders/<id>` (pagina clientului,
 *    verifică proprietarul);
 *  - altfel: lista `/account/orders`. NU folosim niciodată uuid-ul comenzii
 *    pe `/orders/<x>` — acolo uuid-ul merge doar pentru admini (403/404).
 */
import { dbQuery } from "@/lib/db";
import type { Locale } from "@/lib/i18n/config";
import { localeForEmail, normalizeLocale } from "../i18n";
import { emailLink } from "../links";

export type OrderContext = {
  orderId: string | null;
  lookupToken: string | null;
  buyerUserId: string | null;
  locale: Locale;
};

type Row = { id: string; lookup_token: string | null; buyer_user_id: string | null; locale: string | null };

async function fromRow(row: Row | undefined, email: string): Promise<OrderContext | null> {
  if (!row) return null;
  return {
    orderId: row.id,
    lookupToken: row.lookup_token,
    buyerUserId: row.buyer_user_id,
    locale: row.locale ? normalizeLocale(row.locale) : await localeForEmail(email),
  };
}

const SELECT = `SELECT o.id::text, o.metadata->>'order_lookup_token' AS lookup_token,
                       o.buyer_user_id::text, u.locale
                  FROM commerce_orders o LEFT JOIN users u ON u.id = o.buyer_user_id`;

export async function orderContextById(orderId: string, email: string): Promise<OrderContext> {
  try {
    const { rows } = await dbQuery<Row>(`${SELECT} WHERE o.id::text = $1 LIMIT 1`, [orderId]);
    const ctx = await fromRow(rows[0], email);
    if (ctx) return ctx;
  } catch {
    // tabel lipsă / id invalid — cădem pe varianta fără comandă
  }
  return { orderId, lookupToken: null, buyerUserId: null, locale: await localeForEmail(email) };
}

export async function orderContextByTracking(trackingNumber: string, email: string): Promise<OrderContext> {
  try {
    const { rows } = await dbQuery<Row>(
      `${SELECT} JOIN fulfillment_shipments fs ON fs.commerce_order_id = o.id
        WHERE fs.tracking_number = $1 ORDER BY fs.shipped_at DESC NULLS LAST LIMIT 1`,
      [trackingNumber],
    );
    const ctx = await fromRow(rows[0], email);
    if (ctx) return ctx;
  } catch {
    // ignorăm — link generic mai jos
  }
  return { orderId: null, lookupToken: null, buyerUserId: null, locale: await localeForEmail(email) };
}

export function orderLink(ctx: OrderContext): string {
  if (ctx.lookupToken) return emailLink(ctx.locale, `/orders/${encodeURIComponent(ctx.lookupToken)}`);
  if (ctx.buyerUserId && ctx.orderId) return emailLink(ctx.locale, `/account/orders/${encodeURIComponent(ctx.orderId)}`);
  return emailLink(ctx.locale, "/account/orders");
}
