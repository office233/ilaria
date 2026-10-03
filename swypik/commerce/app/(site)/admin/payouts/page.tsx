import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Wallet, ArrowRightLeft, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { AdminForbidden } from "@/components/admin/AdminForbidden";
import { requireAdminPage } from "@/lib/admin/guard";

export const dynamic = "force-dynamic";

type SearchParams = { status?: string; creator?: string; page?: string };

type PayoutKpis = {
  totalCents: number;
  pendingCount: number;
  failedCount: number;
  last30Cents: number;
};

type PayoutRow = {
  id: string;
  status: string;
  amount_cents: number;
  currency: string;
  submitted_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  failure_message: string | null;
  provider_transfer_id: string | null;
  created_at: string;
  creator_id: string | null;
  username: string | null;
  display_name: string | null;
  email: string | null;
};

function statusBadge(status: string) {
  const map: Record<string, string> = {
    succeeded: "bg-green-100 text-green-700",
    pending: "bg-yellow-100 text-yellow-700",
    submitted: "bg-blue-100 text-blue-700",
    failed: "bg-red-100 text-red-700",
    reversed: "bg-orange-100 text-orange-700",
    cancelled: "bg-gray-100 text-gray-700",
  };
  return map[status] || "bg-gray-100 text-gray-700";
}

export default async function PayoutsAdminPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (!(await requireAdminPage("finance"))) return <AdminForbidden />;
  const t = await getTranslations("adminPayouts");
  const locale = await getLocale();
  const sp = await searchParams;
  const status = (sp.status || "").trim();
  const creatorQ = (sp.creator || "").trim();
  const page = Math.max(1, parseInt(sp.page || "1", 10) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;

  const STATUS_OPTIONS = [
    { value: "", label: t("optAll") },
    { value: "pending", label: t("optPending") },
    { value: "submitted", label: t("optSubmitted") },
    { value: "succeeded", label: t("optSucceeded") },
    { value: "failed", label: t("optFailed") },
    { value: "reversed", label: t("optReversed") },
    { value: "cancelled", label: t("optCancelled") },
  ];

  const money = (cents: number, currency: string) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: (currency || "USD").toUpperCase() }).format((cents || 0) / 100);
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
  const fmtDate = (d: Date | string | null) => (d ? dateFmt.format(typeof d === "string" ? new Date(d) : d) : "—");

  let kpis: PayoutKpis = {
    totalCents: 0,
    pendingCount: 0,
    failedCount: 0,
    last30Cents: 0,
  };
  let rows: PayoutRow[] = [];
  let totalRows = 0;
  let loadError: string | null = null;

  try {
    const kpiRes = await dbQuery(
      `SELECT
         COALESCE(SUM(amount_cents), 0)::bigint AS total_cents,
         COUNT(*) FILTER (WHERE status IN ('pending','submitted'))::int AS pending_count,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
         COALESCE(SUM(amount_cents) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::bigint AS last30_cents
       FROM connect_transfers`
    );
    const k = kpiRes.rows[0] || {};
    kpis = {
      totalCents: Number(k.total_cents || 0),
      pendingCount: Number(k.pending_count || 0),
      failedCount: Number(k.failed_count || 0),
      last30Cents: Number(k.last30_cents || 0),
    };

    const filters: string[] = [];
    const params: string[] = [];
    if (status) {
      params.push(status);
      filters.push(`ct.status = $${params.length}`);
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
       FROM connect_transfers ct
       JOIN creator_connect_accounts cca ON cca.id = ct.connect_account_id
       LEFT JOIN users u ON u.id = cca.creator_id
       ${whereSql}`,
      params
    );
    totalRows = Number(countRes.rows[0]?.c || 0);

    const dataParams: (string | number)[] = [...params, limit, offset];
    const res = await dbQuery<PayoutRow>(
      `SELECT ct.id, ct.status, ct.amount_cents, ct.currency, ct.submitted_at, ct.completed_at,
              ct.failed_at, ct.failure_message, ct.provider_transfer_id, ct.created_at,
              cca.creator_id, u.username, u.display_name, u.email
       FROM connect_transfers ct
       JOIN creator_connect_accounts cca ON cca.id = ct.connect_account_id
       LEFT JOIN users u ON u.id = cca.creator_id
       ${whereSql}
       ORDER BY ct.submitted_at DESC NULLS LAST, ct.created_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );
    rows = res.rows;
  } catch (err) {
    logger.error({ err }, "[admin/payouts] failed to load payouts");
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
        <Wallet className="w-7 h-7 text-[#0D0D0D]" />
        <h1 className="text-3xl font-black text-[#0D0D0D]">{t("pageTitle")}</h1>
      </div>

      {loadError && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">
          {loadError}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <KpiCard
          icon={<ArrowRightLeft className="w-5 h-5 text-blue-600" />}
          label={t("totalTransferred")}
          value={money(kpis.totalCents, "USD")}
        />
        <KpiCard
          icon={<Clock className="w-5 h-5 text-yellow-600" />}
          label={t("pendingLabel")}
          value={String(kpis.pendingCount)}
        />
        <KpiCard
          icon={<AlertTriangle className="w-5 h-5 text-red-600" />}
          label={t("failedLabel")}
          value={String(kpis.failedCount)}
        />
        <KpiCard
          icon={<CheckCircle2 className="w-5 h-5 text-green-600" />}
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
            href="/admin/payouts"
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
                <th className="px-4 py-3">{t("thAmount")}</th>
                <th className="px-4 py-3">{t("statusLabel")}</th>
                <th className="px-4 py-3">{t("thSent")}</th>
                <th className="px-4 py-3">{t("thCompleted")}</th>
                <th className="px-4 py-3">{t("thProviderId")}</th>
                <th className="px-4 py-3">{t("thError")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E5E5] text-sm">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                    {t("noTransfers")}
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-[#F7F7F8]/50 transition">
                  <td className="px-4 py-3 max-w-[200px]">
                    <div className="font-bold text-[#0D0D0D] truncate">
                      {r.display_name || r.username || "—"}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {r.username ? `@${r.username}` : r.email || ""}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono font-bold text-[#0D0D0D]">
                    {money(r.amount_cents, r.currency)}
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
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {fmtDate(r.submitted_at)}
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {fmtDate(r.completed_at)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">
                    {r.provider_transfer_id ? r.provider_transfer_id.slice(0, 18) + "…" : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-red-600 max-w-[240px] truncate">
                    {r.failure_message || ""}
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
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
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
    </div>
  );
}
