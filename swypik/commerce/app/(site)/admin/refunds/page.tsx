/**
 * Admin Refunds View — listă restituiri Stripe
 * Read-only: refund-urile sunt inițiate de seller sau via Stripe webhook.
 */
import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { AdminForbidden } from "@/components/admin/AdminForbidden";
import { requireAdminPage } from "@/lib/admin/guard";

export const dynamic = "force-dynamic";

type RefundRow = {
  id: string;
  order_id: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  provider_payment_id: string | null;
  processed_at: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
  order_metadata: { customer_email?: string } | null;
  buyer_email: string | null;
  buyer_username: string | null;
};

async function getRefunds(): Promise<RefundRow[]> {
  try {
    const { rows } = await dbQuery<RefundRow>(
      `SELECT pt.id,
              pt.order_id,
              pt.amount_cents,
              pt.currency,
              pt.status,
              pt.provider_payment_id,
              pt.processed_at,
              pt.created_at,
              pt.metadata,
              co.metadata AS order_metadata,
              u.email AS buyer_email,
              u.username AS buyer_username
         FROM payment_transactions pt
         LEFT JOIN commerce_orders co ON co.id = pt.order_id
         LEFT JOIN users u ON u.id = co.buyer_user_id
        WHERE pt.transaction_type = 'refund'
        ORDER BY pt.created_at DESC
        LIMIT 100`
    );
    return rows;
  } catch (err) {
    logger.error({ err }, "[admin/refunds] query error");
    return [];
  }
}

export default async function AdminRefundsPage() {
  if (!(await requireAdminPage("finance"))) return <AdminForbidden />;
  const t = await getTranslations("adminRefunds");
  const locale = await getLocale();
  const items = await getRefunds();

  const statusLabels: Record<string, string> = {
    pending: t("statusPending"),
    succeeded: t("statusSucceeded"),
    failed: t("statusFailed"),
    cancelled: t("statusCancelled"),
    refunded: t("statusRefunded"),
  };

  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-black text-[#0D0D0D]">{t("pageTitle")}</h1>
        <p className="text-sm text-gray-600 mt-1">{t("pageDesc")}</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-[#E5E5E5] overflow-x-auto">
        <table className="w-full text-left min-w-[800px]">
          <thead className="bg-[#F7F7F8] border-b border-[#E5E5E5] text-sm font-bold text-[#0D0D0D]">
            <tr>
              <th className="px-4 py-3">{t("thRefundId")}</th>
              <th className="px-4 py-3">{t("thOrder")}</th>
              <th className="px-4 py-3">{t("thClient")}</th>
              <th className="px-4 py-3">{t("thAmount")}</th>
              <th className="px-4 py-3">{t("thStatus")}</th>
              <th className="px-4 py-3">{t("thProcessed")}</th>
              <th className="px-4 py-3">{t("thCreated")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E5E5E5] text-sm">
            {items.map((row) => {
              const orderMeta = row.order_metadata || {};
              const buyer =
                row.buyer_email || row.buyer_username || orderMeta.customer_email || t("anonymous");
              const amount = (row.amount_cents || 0) / 100;
              const currency = (row.currency || "RON").toUpperCase();
              const refundId = row.provider_payment_id || row.id;
              return (
                <tr key={row.id} className="hover:bg-[#F7F7F8]/50 transition">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">
                    {String(refundId).slice(0, 18)}…
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">
                    {row.order_id ? (
                      <Link
                        href={`/admin/orders/${row.order_id}`}
                        className="hover:text-[#0D0D0D] hover:underline"
                      >
                        {String(row.order_id).split("-")[0]}…
                      </Link>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700 max-w-[200px] truncate">{buyer}</td>
                  <td className="px-4 py-3 font-medium text-[#0D0D0D]">
                    {new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold bg-gray-100 text-gray-700">
                      {statusLabels[row.status] || row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                    {row.processed_at ? dateFmt.format(new Date(row.processed_at)) : "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                    {dateFmt.format(new Date(row.created_at))}
                  </td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-10 text-center text-gray-500">
                  {t("noRefunds")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
