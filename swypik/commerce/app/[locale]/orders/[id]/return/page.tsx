/**
 * Customer Return Request Form Page (authenticated)
 * /orders/[id]/return
 *
 * Server component: validates ownership + returnability of the order, fetches
 * order_items, and renders <ReturnFormClient/> for the per-item return UI.
 */
import { redirect, notFound } from "next/navigation";
import { Link } from "@/lib/i18n/navigation";
import { ArrowLeft, Undo2 } from "lucide-react";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { canRequestReturn } from "@/lib/commerce/order-status";
import { isEnabled } from "@/lib/feature-flags";
import ReturnFormClient from "./ReturnFormClient";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

type OrderRow = {
  id: string;
  status: string;
  metadata: Record<string, unknown>;
};
type ItemRow = {
  id: string;
  title: string;
  quantity: number;
  unit_amount_cents: number;
  currency: string;
};

export default async function OrderReturnPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Returul e în spatele FEATURE_RETURNS (API-ul dă 410): fără flag, pagina nu există.
  if (!isEnabled("returns")) notFound();
  const t = await getTranslations("ordersReturn");
  const { id } = await params;
  const user = await getAuthUser();
  if (!user.userId) {
    redirect(`/auth?next=${encodeURIComponent(`/orders/${id}/return`)}`);
  }

  const { rows } = await dbQuery<OrderRow>(
    `SELECT id, status, metadata
       FROM commerce_orders
      WHERE id = $1 AND buyer_user_id = $2
      LIMIT 1`,
    [id, user.userId],
  );
  const order = rows[0];
  if (!order) notFound();

  const lookupToken = (order.metadata?.order_lookup_token as string | undefined) || null;
  const allowed = canRequestReturn({
    status: order.status,
    fulfillmentStatus: order.metadata?.fulfillment_status as string | undefined,
    metadata: order.metadata,
    trackingNumber: order.metadata?.tracking_number as string | undefined,
  });
  const alreadyRequested =
    order.status === "return_requested" ||
    !!order.metadata?.return_reason ||
    !!order.metadata?.return_status;

  if (!allowed || alreadyRequested) {
    return (
      <main className="min-h-screen bg-black text-white pb-20">
        <header className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-black/80 backdrop-blur border-b border-white/10">
          <Link href={`/account/orders/${id}`} className="p-1 -ml-1" aria-label={t("inapoi")}>
            <ArrowLeft size={22} />
          </Link>
          <h1 className="text-lg font-black">{t("title")}</h1>
        </header>
        <div className="px-4 pt-8 max-w-xl mx-auto text-center">
          <div className="mb-4 flex justify-center"><Undo2 size={48} /></div>
          <h2 className="text-xl font-black mb-2">
            {alreadyRequested ? t("alreadyRequestedTitle") : t("notYetTitle")}
          </h2>
          <p className="text-sm text-white/60">
            {alreadyRequested
              ? t("alreadyRequestedBody")
              : t("notYetBody")}
          </p>
          <Link
            href={`/account/orders/${id}`}
            className="mt-6 inline-block rounded-xl bg-white px-6 py-3 text-sm font-bold text-black"
          >

            {t("inapoiLaComanda")}
          </Link>
        </div>
      </main>
    );
  }

  const { rows: items } = await dbQuery<ItemRow>(
    `SELECT id, title, quantity, unit_amount_cents, currency
       FROM commerce_order_items
      WHERE order_id = $1
      ORDER BY created_at ASC`,
    [id],
  );

  return (
    <main className="min-h-screen bg-black text-white pb-24">
      <header className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-black/80 backdrop-blur border-b border-white/10">
        <Link href={`/account/orders/${id}`} className="p-1 -ml-1" aria-label={t("inapoi2")}>
          <ArrowLeft size={22} />
        </Link>
        <h1 className="text-lg font-black">{t("title")}</h1>
      </header>
      <div className="px-4 pt-4 max-w-2xl mx-auto">
        <ReturnFormClient
          orderId={order.id}
          lookupToken={lookupToken}
          items={items}
        />
      </div>
    </main>
  );
}
