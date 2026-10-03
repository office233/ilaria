/**
 * Admin Returns Queue — cereri de retur clienți
 */
import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import ReturnActions from "./ReturnActions";
import { AdminForbidden } from "@/components/admin/AdminForbidden";
import { requireAdminPage } from "@/lib/admin/guard";

export const dynamic = "force-dynamic";

const RETURN_STATUS_KEYS = ["requested", "approved", "rejected", "refunded"] as const;
type ReturnStatus = (typeof RETURN_STATUS_KEYS)[number];

type SearchParams = { status?: string };

type ReturnRow = {
  id: string;
  status: string;
  total_cents: number;
  currency: string;
  created_at: string;
  metadata: {
    return_status?: string;
    return_reason?: string;
    return_requested_at?: string;
    customer_email?: string;
  } | null;
  buyer_email: string | null;
  buyer_username: string | null;
  item_count: number;
};

async function getReturns(params: SearchParams): Promise<ReturnRow[]> {
  const status = params.status || "all";
  const where: string[] = [
    "(co.metadata->>'return_status' IS NOT NULL OR co.status = 'return_requested')",
  ];
  const args: string[] = [];
  if (status !== "all" && (RETURN_STATUS_KEYS as readonly string[]).includes(status)) {
    args.push(status);
    where.push(`co.metadata->>'return_status' = $${args.length}`);
  }

  const sql = `
    SELECT co.id,
           co.status,
           co.total_cents,
           co.currency,
           co.created_at,
           co.metadata,
           u.email AS buyer_email,
           u.username AS buyer_username,
           (SELECT COUNT(*) FROM commerce_order_items coi WHERE coi.order_id = co.id)::int AS item_count
    FROM commerce_orders co
    LEFT JOIN users u ON u.id = co.buyer_user_id
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE((co.metadata->>'return_requested_at')::timestamptz, co.created_at) DESC
    LIMIT 100
  `;

  try {
    const { rows } = await dbQuery<ReturnRow>(sql, args);
    return rows;
  } catch (err) {
    logger.error({ err }, "[admin/returns] query error");
    return [];
  }
}

export default async function AdminReturnsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (!(await requireAdminPage("commerce"))) return <AdminForbidden />;
  const t = await getTranslations("adminReturns");
  const locale = await getLocale();
  const sp = await searchParams;
  const activeStatus = sp.status || "all";
  const items = await getReturns(sp);

  const statusLabels: Record<ReturnStatus, string> = {
    requested: t("statusRequested"),
    approved: t("statusApproved"),
    rejected: t("statusRejected"),
    refunded: t("statusRefunded"),
  };

  const tabs: { value: string; label: string }[] = [
    { value: "all", label: t("tabAll") },
    { value: "requested", label: t("tabRequested") },
    { value: "approved", label: t("tabApproved") },
    { value: "rejected", label: t("tabRejected") },
    { value: "refunded", label: t("tabRefunded") },
  ];

  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black text-[#0D0D0D]">{t("pageTitle")}</h1>
          <p className="text-sm text-gray-600 mt-1">{t("pageDesc")}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {tabs.map((tab) => {
          const href =
            tab.value === "all" ? "/admin/returns" : `/admin/returns?status=${tab.value}`;
          const active = activeStatus === tab.value;
          return (
            <Link
              key={tab.value}
              href={href}
              className={`inline-flex items-center px-4 py-2.5 rounded-full text-xs font-bold border transition min-h-[40px] ${
                active
                  ? "bg-[#0D0D0D] text-white border-[#0D0D0D]"
                  : "bg-white text-gray-700 border-[#E5E5E5] hover:border-[#0D0D0D]"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-[#E5E5E5] overflow-x-auto">
        <table className="w-full text-left min-w-[900px]">
          <thead className="bg-[#F7F7F8] border-b border-[#E5E5E5] text-sm font-bold text-[#0D0D0D]">
            <tr>
              <th className="px-4 py-3">{t("thOrder")}</th>
              <th className="px-4 py-3">{t("thClient")}</th>
              <th className="px-4 py-3">{t("thItems")}</th>
              <th className="px-4 py-3">{t("thTotal")}</th>
              <th className="px-4 py-3">{t("thReason")}</th>
              <th className="px-4 py-3">{t("thStatus")}</th>
              <th className="px-4 py-3">{t("thRequested")}</th>
              <th className="px-4 py-3">{t("thActions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E5E5E5] text-sm">
            {items.map((row) => {
              const meta = row.metadata || {};
              const rs = meta.return_status || (row.status === "return_requested" ? "requested" : null);
              const reason = meta.return_reason || "—";
              const requestedAt = meta.return_requested_at || row.created_at;
              const buyer =
                row.buyer_email || row.buyer_username || meta.customer_email || t("anonymous");
              const total = (row.total_cents || 0) / 100;
              const currency = (row.currency || "RON").toUpperCase();
              return (
                <tr key={row.id} className="hover:bg-[#F7F7F8]/50 transition align-top">
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">
                    <Link
                      href={`/admin/orders/${row.id}`}
                      className="hover:text-[#0D0D0D] hover:underline"
                    >
                      {String(row.id).split("-")[0]}…
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-700 max-w-[180px] truncate">{buyer}</td>
                  <td className="px-4 py-3 text-gray-700">{row.item_count}</td>
                  <td className="px-4 py-3 font-medium text-[#0D0D0D]">
                    {new Intl.NumberFormat(locale, { style: "currency", currency }).format(total)}
                  </td>
                  <td className="px-4 py-3 text-gray-600 max-w-[260px]">
                    <span className="line-clamp-2">{reason}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold bg-gray-100 text-gray-700">
                      {rs ? statusLabels[rs as ReturnStatus] || rs : "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                    {requestedAt ? dateFmt.format(new Date(requestedAt)) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <ReturnActions orderId={row.id} status={rs} />
                  </td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-6 py-10 text-center text-gray-500">
                  {t("noReturns")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
