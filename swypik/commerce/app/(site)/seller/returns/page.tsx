/**
 * Seller — Returns awaiting action.
 * /seller/returns
 *
 * Lists orders where this seller has at least one item AND a return is in
 * 'requested' state. Provides accept (full Stripe refund via existing
 * /api/seller/orders/[id]/refund) and reject buttons.
 */

import { redirect, notFound } from "next/navigation";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { isEnabled } from "@/lib/feature-flags";
import SellerReturnsClient from "./SellerReturnsClient";

export const dynamic = "force-dynamic";

type ReturnRow = {
  id: string;
  status: string;
  created_at: string;
  total_cents: number;
  currency: string;
  return_reason: string | null;
  return_requested_at: string | null;
  evidence_urls: string[];
  buyer_email: string | null;
};

export default async function SellerReturnsPage() {
  // Modulul de retururi e OFF by default (FEATURE_RETURNS) — API-urile de
  // accept/refund/reject întorc deja 410 în acest caz; pagina trebuie să
  // reflecte același gate, altfel sellerul vede o listă ale cărei butoane
  // eșuează silențios.
  if (!isEnabled("returns")) notFound();

  const sellerId = await getSellerSessionId();
  if (!sellerId) redirect("/seller/login?next=/seller/returns");

  const { rows } = await dbQuery<ReturnRow>(
    `SELECT
       co.id,
       co.status,
       co.created_at,
       co.total_cents,
       co.currency,
       co.metadata->>'return_reason'         AS return_reason,
       co.metadata->>'return_requested_at'   AS return_requested_at,
       COALESCE(co.metadata->'return_evidence_urls', '[]'::jsonb) AS evidence_urls,
       co.metadata->>'buyer_email'           AS buyer_email
     FROM commerce_orders co
     JOIN commerce_order_items coi ON co.id = coi.order_id
     WHERE coi.metadata->>'seller_id' = $1
       AND co.status = 'return_requested'
       AND COALESCE(co.metadata->>'return_status', 'requested') = 'requested'
     GROUP BY co.id
     ORDER BY (co.metadata->>'return_requested_at') DESC NULLS LAST, co.created_at DESC
     LIMIT 200`,
    [sellerId]
  );

  return <SellerReturnsClient initialRows={rows} />;
}
