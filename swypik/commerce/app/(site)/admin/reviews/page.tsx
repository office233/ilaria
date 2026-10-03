/**
 * Admin Reviews — moderare recenzii produs
 */
import { dbQuery } from "@/lib/db";
import { getTranslations, getLocale } from "next-intl/server";
import Link from "next/link";
import { Star, ExternalLink, ShieldCheck } from "lucide-react";
import ReviewActions from "./ReviewActions";
import { AdminForbidden } from "@/components/admin/AdminForbidden";
import { requireAdminPage } from "@/lib/admin/guard";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type SearchParams = {
  rating?: string;
  status?: string;
  q?: string;
  page?: string;
};

type Row = {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  is_hidden: boolean;
  is_verified_purchase: boolean;
  helpful_count: number;
  created_at: string;
  user_id: string | null;
  username: string | null;
  display_name: string | null;
  product_id: string | null;
  product_title: string | null;
  product_thumb: string | null;
};

async function getReviews(params: SearchParams): Promise<{ rows: Row[]; total: number; page: number }> {
  const page = Math.max(1, parseInt(params.page || "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const rating = params.rating ? parseInt(params.rating, 10) : null;
  const q = params.q?.trim() || null;
  const status = params.status === "hidden" ? "hidden" : params.status === "visible" ? "visible" : "all";

  const where: string[] = [];
  const args: unknown[] = [];
  if (rating && rating >= 1 && rating <= 5) {
    args.push(rating);
    where.push(`pr.rating = $${args.length}`);
  }
  if (q) {
    args.push(`%${q}%`);
    where.push(`(pr.body ILIKE $${args.length} OR pr.title ILIKE $${args.length})`);
  }
  if (status === "hidden") where.push(`pr.is_hidden = true`);
  if (status === "visible") where.push(`pr.is_hidden = false`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRes = await dbQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM product_reviews pr ${whereSql}`,
    args
  );
  const total = parseInt(totalRes.rows[0]?.c || "0", 10);

  args.push(PAGE_SIZE);
  args.push(offset);
  const { rows } = await dbQuery<Row>(
    `SELECT pr.id, pr.rating, pr.title, pr.body, pr.is_hidden, pr.is_verified_purchase,
            pr.helpful_count, pr.created_at,
            u.id AS user_id, u.username, u.display_name,
            p.id AS product_id, p.title AS product_title, p.image_url AS product_thumb
       FROM product_reviews pr
       LEFT JOIN users u ON u.id = pr.user_id
       LEFT JOIN marketplace_products p ON p.id = pr.product_id
       ${whereSql}
       ORDER BY pr.created_at DESC
       LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args
  );

  return { rows, total, page };
}

function fmtDate(s: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(s));
  } catch {
    return s;
  }
}

function StarRow({ n, starsLabel }: { n: number; starsLabel: string }) {
  return (
    <div className="inline-flex items-center gap-0.5" aria-label={starsLabel}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          size={12}
          className={i <= n ? "fill-yellow-400 text-yellow-400" : "text-gray-300"}
        />
      ))}
    </div>
  );
}

export default async function AdminReviewsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (!(await requireAdminPage("commerce"))) return <AdminForbidden />;
  const t = await getTranslations("adminReviews");
  const locale = await getLocale();
  const sp = await searchParams;
  const { rows, total, page } = await getReviews(sp);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function pageHref(p: number): string {
    const u = new URLSearchParams();
    if (sp.rating) u.set("rating", sp.rating);
    if (sp.status) u.set("status", sp.status);
    if (sp.q) u.set("q", sp.q);
    u.set("page", String(p));
    return `/admin/reviews?${u.toString()}`;
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-black mb-1">{t("pageTitle")}</h1>
      <p className="text-sm text-gray-600 mb-4">
        {t("summaryLine", { total: new Intl.NumberFormat(locale).format(total), page, totalPages })}
      </p>

      <form method="GET" className="flex flex-wrap gap-2 mb-6 items-end">
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">{t("ratingLabel")}</label>
          <select
            name="rating"
            defaultValue={sp.rating || ""}
            className="border rounded px-2 py-1.5 text-sm"
          >
            <option value="">{t("all")}</option>
            {[5, 4, 3, 2, 1].map((r) => (
              <option key={r} value={r}>
                {t("starsCount", { count: r })}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">{t("statusLabel")}</label>
          <select
            name="status"
            defaultValue={sp.status || ""}
            className="border rounded px-2 py-1.5 text-sm"
          >
            <option value="">{t("all")}</option>
            <option value="visible">{t("visible")}</option>
            <option value="hidden">{t("hidden")}</option>
          </select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-semibold text-gray-700 mb-1">{t("searchLabel")}</label>
          <input
            type="text"
            name="q"
            defaultValue={sp.q || ""}
            placeholder={t("searchPlaceholder")}
            className="w-full border rounded px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          className="px-4 py-1.5 bg-black text-white rounded text-sm font-semibold hover:bg-gray-800"
        >
          {t("filterBtn")}
        </button>
        <Link
          href="/admin/reviews"
          className="px-4 py-1.5 border border-gray-300 rounded text-sm hover:bg-gray-50"
        >
          {t("reset")}
        </Link>
      </form>

      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-600">
            <tr>
              <th className="px-3 py-2">{t("thRating")}</th>
              <th className="px-3 py-2">{t("thReview")}</th>
              <th className="px-3 py-2">{t("thAuthor")}</th>
              <th className="px-3 py-2">{t("thProduct")}</th>
              <th className="px-3 py-2">{t("thHelpful")}</th>
              <th className="px-3 py-2">{t("thDate")}</th>
              <th className="px-3 py-2">{t("thActions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                  {t("noReviews")}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.id}
                className={`border-t border-gray-100 ${r.is_hidden ? "bg-yellow-50" : ""}`}
              >
                <td className="px-3 py-2 align-top">
                  <StarRow n={r.rating} starsLabel={t("starsCount", { count: r.rating })} />
                </td>
                <td className="px-3 py-2 align-top max-w-md">
                  {r.title && <div className="font-semibold text-xs mb-0.5">{r.title}</div>}
                  <div className="text-xs text-gray-700 line-clamp-3">
                    {r.body || <span className="italic text-gray-400">{t("noText")}</span>}
                  </div>
                  {r.is_verified_purchase && (
                    <div className="inline-flex items-center gap-1 mt-1 text-[10px] text-green-700">
                      <ShieldCheck size={10} /> {t("verifiedPurchase")}
                    </div>
                  )}
                  {r.is_hidden && (
                    <div className="mt-1 text-[10px] font-bold text-yellow-700 uppercase">
                      {t("hidden")}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-xs">
                  {r.username ? (
                    <Link
                      href={`/u/${r.username}`}
                      className="text-blue-600 hover:underline"
                    >
                      @{r.username}
                    </Link>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                  {r.display_name && (
                    <div className="text-gray-500">{r.display_name}</div>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-xs">
                  {r.product_id ? (
                    <Link
                      href={`/product/${r.product_id}`}
                      className="text-blue-600 hover:underline inline-flex items-center gap-1"
                    >
                      <span className="line-clamp-2 max-w-[180px]">
                        {r.product_title || r.product_id.slice(0, 8)}
                      </span>
                      <ExternalLink size={10} />
                    </Link>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-xs">{r.helpful_count}</td>
                <td className="px-3 py-2 align-top text-xs whitespace-nowrap">
                  {fmtDate(r.created_at, locale)}
                </td>
                <td className="px-3 py-2 align-top">
                  <ReviewActions reviewId={r.id} isHidden={r.is_hidden} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          {page > 1 && (
            <Link
              href={pageHref(page - 1)}
              className="px-3 py-1 border rounded text-sm hover:bg-gray-50"
            >
              {t("previous")}
            </Link>
          )}
          <span className="text-sm text-gray-600">
            {page} / {totalPages}
          </span>
          {page < totalPages && (
            <Link
              href={pageHref(page + 1)}
              className="px-3 py-1 border rounded text-sm hover:bg-gray-50"
            >
              {t("next")}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
