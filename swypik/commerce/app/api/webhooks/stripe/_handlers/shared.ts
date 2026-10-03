import { dbQuery } from "@/lib/db";
import { sendOrderConfirmation } from "@/lib/email/service";
import { activeProvider } from "@/lib/email/transport";
import { logger } from "@/lib/logger";

type ShippingAddress = { name?: string; line1?: string; city?: string; postal_code?: string; country?: string };

/**
 * Emailul de confirmare a comenzii (tranzacțional — nu depinde de flag-ul de
 * marketing). Idempotent prin `confirmation_email_sent_at`. Fără provider de
 * email configurat: doar log, comanda NU e marcată ca notificată, ca emailul
 * să plece la primul eveniment după ce providerul e configurat.
 */
export async function maybeSendOrderConfirmation(orderId: string) {
  const { rows: orderRows } = await dbQuery<{
    id: string;
    total_cents: number;
    metadata: Record<string, unknown> | null;
    buyer_email: string | null;
  }>(
    `SELECT o.id, o.total_cents, o.metadata, u.email AS buyer_email
       FROM commerce_orders o
       LEFT JOIN users u ON u.id = o.buyer_user_id
      WHERE o.id = $1
      LIMIT 1`,
    [orderId],
  );
  const order = orderRows[0];
  if (!order) return;

  const metadata = order.metadata || {};
  const customerEmail =
    (typeof metadata.customer_email === "string" && metadata.customer_email) || order.buyer_email || null;
  if (!customerEmail || metadata.confirmation_email_sent_at) return;

  if (activeProvider() === "none") {
    logger.warn({ orderId }, "[order-email] niciun provider de email configurat — confirmarea nu a fost trimisă");
    return;
  }

  const { rows: itemRows } = await dbQuery<{ title: string; quantity: number; price: string }>(
    `SELECT title, quantity, (unit_amount_cents::numeric / 100) AS price
       FROM commerce_order_items
      WHERE order_id = $1`,
    [orderId],
  );
  const shipping = (metadata.shipping_address as ShippingAddress | undefined) || undefined;

  const sent = await sendOrderConfirmation({
    orderId,
    orderLookupToken: typeof metadata.order_lookup_token === "string" ? metadata.order_lookup_token : undefined,
    customerEmail,
    customerName: shipping?.name || "",
    items: itemRows.map((r) => ({ title: r.title, quantity: r.quantity, price: Number(r.price) })),
    totalRon: Number(order.total_cents || 0) / 100,
    shippingAddress: shipping,
  });

  if (sent) {
    await dbQuery(
      `UPDATE commerce_orders
          SET metadata = metadata || jsonb_build_object('confirmation_email_sent_at', now()::text)
        WHERE id = $1`,
      [orderId],
    );
  }
}
