/**
 * Admin Creators — top creators by followers + sales
 */
import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { BadgeCheck } from "lucide-react";
import { dbQuery } from "@/lib/db";
import { requireAdminSession } from "@/lib/security/admin-auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  is_verified: boolean;
  followers: string;
  videos: string;
  sales_count: string;
  sales_cents: string;
};

function fmtMoney(cents: string | number, locale: string): string {
  const n = Number(cents) || 0;
  return new Intl.NumberFormat(locale, { style: "currency", currency: "RON", maximumFractionDigits: 0 }).format(n / 100);
}

export default async function AdminCreatorsPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; q?: string }>;
}) {
  const t = await getTranslations("adminCreators");
  const locale = await getLocale();
  await requireAdminSession();
  const sp = await searchParams;
  const sort = sp.sort === "sales" ? "sales" : sp.sort === "videos" ? "videos" : "followers";
  const q = (sp.q || "").trim();

  const orderSql =
    sort === "sales"
      ? "sales_cents DESC, followers DESC"
      : sort === "videos"
        ? "videos DESC, followers DESC"
        : "followers DESC, videos DESC";

  let rows: Row[] = [];
  let loadError: string | null = null;

  try {
    const params: string[] = [];
    let searchSql = "";
    if (q) {
      params.push(q);
      searchSql = `AND (u.username ILIKE '%'||$1||'%' OR u.display_name ILIKE '%'||$1||'%')`;
    }
    const res = await dbQuery(
      `
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_verified,
             (SELECT COUNT(*) FROM follows WHERE following_user_id = u.id)::text AS followers,
             (SELECT COUNT(*) FROM videos WHERE creator_id = u.id)::text AS videos,
             (SELECT COUNT(*) FROM commerce_order_items WHERE creator_id = u.id)::text AS sales_count,
             COALESCE((SELECT SUM(gross_amount_cents) FROM commerce_order_items WHERE creator_id = u.id), 0)::text AS sales_cents
      FROM users u
      WHERE (u.role IN ('creator', 'admin') OR EXISTS (SELECT 1 FROM creators c WHERE c.email = u.email))
      ${searchSql}
      ORDER BY ${orderSql}
      LIMIT 100
      `,
      params
    );
    rows = res.rows as Row[];
  } catch (e) {
    logger.error({ err: e }, "[admin/creators] failed to load creators");
    loadError = t("loadError");
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-black text-[#0D0D0D]">{t("pageTitle")}</h1>
        <p className="text-sm text-black/60 mt-1">
          {t("topByLine", {
            count: rows.length,
            metric: sort === "sales" ? t("metricSales") : sort === "videos" ? t("metricVideos") : t("metricFollowers"),
          })}
        </p>
      </div>

      <form className="mb-4 flex flex-wrap items-center gap-2" action="/admin/creators" method="GET">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={t("searchPlaceholder")}
          className="rounded-lg border border-black/15 px-3 py-2 text-sm w-64"
        />
        <input type="hidden" name="sort" value={sort} />
        <button type="submit" className="rounded-lg bg-black text-white px-4 py-2 text-sm font-bold">{t("searchBtn")}</button>
        <div className="ml-auto flex flex-wrap gap-2">
          {(["followers", "videos", "sales"] as const).map((s) => (
            <Link
              key={s}
              href={`/admin/creators?sort=${s}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={`inline-flex items-center rounded-md px-4 py-2.5 text-xs font-bold border min-h-[40px] ${sort === s ? "bg-black text-white border-black" : "border-black/15 text-black/70"
                }`}
            >
              {s === "followers" ? t("metricFollowers") : s === "videos" ? t("metricVideos") : t("metricSales")}
            </Link>
          ))}
        </div>
      </form>

      {loadError && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{loadError}</div>
      )}

      <div className="bg-white rounded-2xl border border-black/10 overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="bg-black/5 text-left text-xs uppercase tracking-wide text-black/60">
            <tr>
              <th className="px-4 py-3">{t("thCreator")}</th>
              <th className="px-4 py-3 text-right">{t("thFollowers")}</th>
              <th className="px-4 py-3 text-right">{t("thVideos")}</th>
              <th className="px-4 py-3 text-right">{t("thSalesCount")}</th>
              <th className="px-4 py-3 text-right">{t("thSalesTotal")}</th>
              <th className="px-4 py-3 text-right">{t("thActions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-black/50">{t("noCreators")}</td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-black/5">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    {r.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-black/10" />
                    )}
                    <div>
                      <div className="font-bold flex items-center gap-1">
                        @{r.username}
                        {r.is_verified && <BadgeCheck size={14} className="text-blue-600" />}
                      </div>
                      {r.display_name && <div className="text-xs text-black/50">{r.display_name}</div>}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{new Intl.NumberFormat(locale).format(Number(r.followers))}</td>
                <td className="px-4 py-3 text-right tabular-nums">{new Intl.NumberFormat(locale).format(Number(r.videos))}</td>
                <td className="px-4 py-3 text-right tabular-nums">{new Intl.NumberFormat(locale).format(Number(r.sales_count))}</td>
                <td className="px-4 py-3 text-right tabular-nums font-bold">{fmtMoney(r.sales_cents, locale)}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <Link href={`/u/${r.username}`} className="text-xs font-bold text-blue-600 hover:underline">{t("profileLink")}</Link>
                    <Link href={`/admin/users?q=${encodeURIComponent(r.username)}`} className="text-xs font-bold text-black/60 hover:underline">{t("userLink")}</Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
