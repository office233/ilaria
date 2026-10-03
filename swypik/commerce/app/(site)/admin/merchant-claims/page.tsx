/**
 * Admin — cereri de revendicare a restaurantelor (merchant_claim_requests).
 * Aprobarea leagă sellerul proprietarului și face restaurantul comandabil.
 */
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { requireAdminSession } from "@/lib/security/admin-auth";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import ClaimActions from "./ClaimActions";

export const dynamic = "force-dynamic";

type ClaimRow = {
  id: string;
  status: "pending" | "approved" | "rejected";
  contact_name: string | null;
  contact_phone: string;
  contact_email: string | null;
  message: string | null;
  review_note: string | null;
  created_at: string;
  merchant_name: string;
  merchant_slug: string;
  merchant_city: string | null;
  merchant_source: string | null;
  merchant_status: string;
  user_email: string | null;
  user_name: string | null;
  suggestion_count: number;
};

const TONE = { pending: "warning", approved: "success", rejected: "danger" } as const;

export default async function MerchantClaimsPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  await requireAdminSession();
  const t = await getTranslations("foodAdmin");
  const locale = await getLocale();
  const { f } = await searchParams;
  const onlyPending = f !== "all";

  const { rows } = await dbQuery<ClaimRow>(
    `SELECT c.id, c.status, c.contact_name, c.contact_phone, c.contact_email, c.message, c.review_note,
            c.created_at::text, m.name AS merchant_name, m.slug AS merchant_slug, m.location_city AS merchant_city,
            m.source AS merchant_source, m.status AS merchant_status, m.suggestion_count,
            u.email AS user_email, COALESCE(u.display_name, u.username) AS user_name
       FROM merchant_claim_requests c
       JOIN local_merchants m ON m.id = c.merchant_id
       LEFT JOIN users u ON u.id = c.user_id
      WHERE ($1::boolean = false OR c.status = 'pending')
      ORDER BY (c.status = 'pending') DESC, c.created_at DESC
      LIMIT 200`,
    [onlyPending],
  );
  const date = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="space-y-4 p-gutter">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-black text-fg">{t("claimsTitle")}</h1>
        <div className="ml-auto flex gap-2">
          <Link href="/admin/merchant-claims" className={`rounded-control px-3 py-2 text-sm font-bold ${onlyPending ? "bg-brand text-brand-fg" : "bg-surface-2 text-muted"}`}>
            {t("filterPending")}
          </Link>
          <Link href="/admin/merchant-claims?f=all" className={`rounded-control px-3 py-2 text-sm font-bold ${!onlyPending ? "bg-brand text-brand-fg" : "bg-surface-2 text-muted"}`}>
            {t("filterAll")}
          </Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={t("claimsEmpty")} description={t("claimsEmptySub")} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((c) => (
            <Card key={c.id} variant="outline" className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/food/${c.merchant_slug}`} className="block truncate font-black text-fg hover:underline">
                    {c.merchant_name}
                  </Link>
                  <p className="text-xs text-muted">
                    {[c.merchant_city, c.merchant_source === "osm" ? t("sourceOsm") : null, t("suggestions", { count: c.suggestion_count })]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Badge tone={TONE[c.status]}>{t(`status_${c.status}`)}</Badge>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted">{t("claimant")}</dt>
                <dd className="truncate text-fg">{c.contact_name ?? c.user_name ?? "—"}</dd>
                <dt className="text-muted">{t("phone")}</dt>
                <dd className="text-fg">{c.contact_phone}</dd>
                <dt className="text-muted">{t("email")}</dt>
                <dd className="truncate text-fg">{c.contact_email || c.user_email || "—"}</dd>
                <dt className="text-muted">{t("received")}</dt>
                <dd className="text-fg">{date.format(new Date(c.created_at))}</dd>
              </dl>
              {c.message && <p className="rounded-control bg-surface-2 p-2 text-sm text-fg">{c.message}</p>}
              {c.review_note && <p className="text-xs text-muted">{t("reviewNote", { note: c.review_note })}</p>}
              {c.status === "pending" && <ClaimActions claimId={c.id} />}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
