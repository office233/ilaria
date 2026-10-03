import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Coins, BarChart3, Clock, CheckCircle2 } from "lucide-react";
import { AdminForbidden } from "@/components/admin/AdminForbidden";
import { requireAdminPage } from "@/lib/admin/guard";

export const dynamic = "force-dynamic";

type SearchParams = { status?: string; creator?: string; page?: string };

type CommissionRow = {
  id: string;
  creator_id: string | null;
  gross_amount_cents: number;
  creator_amount_cents: number;
  platform_fee_cents: number;
  currency: string;
  status: string;
  commission_type: string;
  created_at: string;
  paid_at: string | null;
  commerce_order_id: string | null;
  video_id: string | null;
  commission_rate_bps: number | null;
  username: string | null;
  display_name: string | null;
};

function statusBadge(status: string) {
  const map: Record<string, string> = {
    paid: "bg-green-100 text-green-700",
    payable: "bg-blue-100 text-blue-700",
    approved: "bg-emerald-100 text-emerald-700",
    pending: "bg-yellow-100 text-yellow-700",
    void: "bg-gray-100 text-gray-700",
    refunded: "bg-orange-100 text-orange-700",
  };
  return map[status] || "bg-gray-100 text-gray-700";
}

export default async function CommissionsAdminPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (!(await requireAdminPage("finance"))) return <AdminForbidden />;
  const t = await getTranslations("adminCommissions");
  const locale = await getLocale();
  const sp = await searchParams;
  const status = (sp.status || "").trim();
  const creatorQ = (sp.creator || "").trim();
  const page = Math.max(1, parseInt(sp.page || "1", 10) || 1);
  const limit = 100;
  const offset = (page - 1) * limit;

  const STATUS_OPTIONS = [
    { value: "", label: t("optAll") },
    { value: "pending", label: t("optPending") },
    { value: "approved", label: t("optApproved") },
    { value: "payable", label: t("optPayable") },
    { value: "paid", label: t("optPaid") },
    { value: "void", label: t("optVoid") },
    { value: "refunded", label: t("optRefunded") },
  ];

  const money = (cents: number, currency: string) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: (currency || "USD").toUpperCase() }).format((cents || 0) / 100);
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
  const fmtDate = (d: Date | string | null) => (d ? dateFmt.format(typeof d === "string" ? new Date(d) : d) : "—");

  let kpis = {
    totalCreatorCents: 0,
    totalGrossCents: 0,
    pendingCount: 0,
    paidCount: 0,
    last30Cents: 0,
  };
  let rows: CommissionRow[] = [];
  let totalRows = 0;
  let loadError: string | null = null;

  try {
    const kpiRes = await dbQuery(
      `SELECT
         COALESCE(SUM(creator_amount_cents), 0)::bigint AS total_creator_cents,
         COALESCE(SUM(gross_amount_cents), 0)::bigint AS total_gross_cents,
         COUNT(*) FILTER (WHERE status IN ('pending','approved','payable'))::int AS pending_count,
         COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
         COALESCE(SUM(creator_amount_cents) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::bigint AS last30_cents
       FROM commissions`
    );
    const k = kpiRes.rows[0] || {};
    kpis = {
      totalCreatorCents: Number(k.total_creator_cents || 0),
      totalGrossCents: Number(k.total_gross_cents || 0),
      pendingCount: Number(k.pending_count || 0),
      paidCount: Number(k.paid_count || 0),
      last30Cents: Number(k.last30_cents || 0),
    };

    const filters: string[] = [];
    const params: string[] = [];
    if (status) {
      params.push(status);
      filters.push(`c.status = $${params.length}`);
    }
    if (creatorQ) {
      params.push(`%${creatorQ}%`);
      filters.push(
        `(u.username ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.display_name ILIKE $${params.length})`
      );
    }
    const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const countRes = await dbQuery(
      `SELECT COUNT(*)::int AS c
       FROM commissions c
       LEFT JOIN users u ON u.id = c.creator_id
       ${whereSql}`,
      params
    );
    totalRows = Number(countRes.rows[0]?.c || 0);

    const dataParams: (string | number)[] = [...params, limit, offset];
    const res = await dbQuery<CommissionRow>(
      `SELECT c.id, c.creator_id, c.gross_amount_cents, c.creator_amount_cents,
              c.platform_fee_cents, c.currency, c.status, c.commission_type,
              c.created_at, c.paid_at, c.commerce_order_id, c.video_id,
              c.commission_rate_bps,
              u.username, u.display_name
       FROM commissions c
       LEFT JOIN users u ON u.id = c.creator_id
       ${whereSql}
       ORDER BY c.created_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );
    rows = res.rows;
  } catch (err) {
    logger.error({ err }, "[admin/commissions] failed to load commissions");
    loadError = t("loadError");
  }

  const totalPages = Math.max(1, Math.ceil(totalRows / limit));
  const baseQs = (extra: Record<string, string | number>) => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (creatorQ) q.set("creator", creatorQ);
    for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
    return `?${q.toString()}`;
  };

  return (
    <div className="p-4 md:p-8">
      <div className="flex items-center gap-3 mb-6">
        <BarChart3 className="w-7 h-7 text-[#0D0D0D]" />
        <h1 className="text-3xl font-black text-[#0D0D0D]">{t("pageTitle")}</h1>
      </div>

      {loadError && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">
          {loadError}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <KpiCard
          icon={<Coins className="w-5 h-5 text-emerald-600" />}
          label={t("totalCreators")}
          value={money(kpis.totalCreatorCents, "USD")}
          sub={t("grossLabel", { amount: money(kpis.totalGrossCents, "USD") })}
        />
        <KpiCard
          icon={<Clock className="w-5 h-5 text-yellow-600" />}
          label={t("pendingLabel")}
          value={String(kpis.pendingCount)}
        />
        <KpiCard
          icon={<CheckCircle2 className="w-5 h-5 text-green-600" />}
          label={t("paidLabel")}
          value={String(kpis.paidCount)}
        />
        <KpiCard
          icon={<BarChart3 className="w-5 h-5 text-blue-600" />}
          label={t("last30Days")}
          value={money(kpis.last30Cents, "USD")}
        />
      </div>

      <form
        method="get"
        className="mb-4 flex flex-wrap items-end gap-3 bg-white rounded-xl border border-[#E5E5E5] p-4"
      >
        <div className="flex flex-col">
          <label htmlFor="status" className="text-xs font-bold text-gray-600 mb-1">
            {t("statusLabel")}
          </label>
          <select
            id="status"
            name="status"
            defaultValue={status}
            className="px-3 py-2 rounded-lg border border-[#E5E5E5] text-sm bg-white"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col flex-1 min-w-[200px]">
          <label htmlFor="creator" className="text-xs font-bold text-gray-600 mb-1">
            {t("creatorSearchLabel")}
          </label>
          <input
            id="creator"
            name="creator"
            defaultValue={creatorQ}
            placeholder={t("searchPlaceholder")}
            className="px-3 py-2 rounded-lg border border-[#E5E5E5] text-sm"
          />
        </div>
        <button
          type="submit"
          className="px-4 py-2 rounded-lg bg-[#0D0D0D] text-white text-sm font-bold hover:bg-black transition"
        >
          {t("filterBtn")}
        </button>
        {(status || creatorQ) && (
          <Link
            href="/admin/commissions"
            className="px-4 py-2 rounded-lg border border-[#E5E5E5] text-sm font-bold text-gray-700 hover:bg-gray-50"
          >
            {t("resetBtn")}
          </Link>
        )}
      </form>

      <div className="bg-white rounded-xl shadow-sm border border-[#E5E5E5] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-[#F7F7F8] border-b border-[#E5E5E5] text-sm font-bold text-[#0D0D0D]">
              <tr>
                <th className="px-4 py-3">{t("thCreator")}</th>
                <th className="px-4 py-3">{t("thType")}</th>
                <th className="px-4 py-3">{t("thGross")}</th>
                <th className="px-4 py-3">{t("thCreator")}</th>
                <th className="px-4 py-3">{t("thPlatform")}</th>
                <th className="px-4 py-3">{t("thRate")}</th>
                <th className="px-4 py-3">{t("statusLabel")}</th>
                <th className="px-4 py-3">{t("thOrder")}</th>
                <th className="px-4 py-3">{t("thCreated")}</th>
                <th className="px-4 py-3">{t("thPaid")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E5E5] text-sm">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-gray-500">
                    {t("noCommissions")}
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-[#F7F7F8]/50 transition">
                  <td className="px-4 py-3">
                    <div className="font-bold text-[#0D0D0D]">
                      {r.display_name || r.username || "—"}
                    </div>
                    {r.username && (
                      <div className="text-xs text-gray-500">@{r.username}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">{r.commission_type}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">
                    {money(r.gross_amount_cents, r.currency)}
                  </td>
                  <td className="px-4 py-3 font-mono font-bold text-emerald-700">
                    {money(r.creator_amount_cents, r.currency)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">
                    {money(r.platform_fee_cents, r.currency)}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {r.commission_rate_bps != null
                      ? `${(r.commission_rate_bps / 100).toFixed(2)}%`
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex px-2.5 py-1 rounded-full text-xs font-bold ${statusBadge(
                        r.status
                      )}`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">
                    {r.commerce_order_id ? (
                      <Link
                        href={`/admin/orders/${r.commerce_order_id}`}
                        className="hover:underline hover:text-[#0D0D0D]"
                      >
                        {String(r.commerce_order_id).split("-")[0]}…
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {fmtDate(r.created_at)}
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {fmtDate(r.paid_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <div className="text-gray-600">
            {t("pageOf", { page, total: totalPages, rows: totalRows })}
          </div>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={baseQs({ page: page - 1 })}
                className="px-3 py-1.5 rounded-lg border border-[#E5E5E5] font-bold hover:bg-gray-50"
              >
                {t("prevPage")}
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={baseQs({ page: page + 1 })}
                className="px-3 py-1.5 rounded-lg border border-[#E5E5E5] font-bold hover:bg-gray-50"
              >
                {t("nextPage")}
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-[#E5E5E5] p-4">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-xs font-bold uppercase tracking-wide text-gray-500">
          {label}
        </span>
      </div>
      <div className="text-2xl font-black text-[#0D0D0D]">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}
