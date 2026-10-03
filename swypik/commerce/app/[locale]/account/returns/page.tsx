import { Link } from "@/lib/i18n/navigation";
import { redirect } from "next/navigation";
import { ArrowLeft, PackageSearch } from "lucide-react";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { getLocale, getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

type ReturnRow = {
  id: string;
  status: string;
  created_at: string;
  total_cents: number;
  currency: string;
  return_reason: string | null;
  return_status: string | null;
  return_requested_at: string | null;
};

/** Status retur → cheie din namespace-ul `accountReturns`. */
const RETURN_STATUS_KEY: Record<string, "statusRequested" | "statusApproved" | "statusRejected" | "statusCompleted"> = {
  requested: "statusRequested",
  approved: "statusApproved",
  rejected: "statusRejected",
  completed: "statusCompleted",
};

export default async function ReturnsPage() {
  const t = await getTranslations("accountReturns");
  const locale = await getLocale();
  const user = await getAuthUser();
  if (!user.userId) redirect("/auth?next=/account/returns");

  const { rows } = await dbQuery<ReturnRow>(
    `SELECT id, status, created_at, total_cents, currency,
            metadata->>'return_reason' AS return_reason,
            metadata->>'return_status' AS return_status,
            metadata->>'return_requested_at' AS return_requested_at
       FROM commerce_orders
      WHERE buyer_user_id = $1
        AND (status = 'return_requested' OR metadata ? 'return_reason')
      ORDER BY (metadata->>'return_requested_at') DESC NULLS LAST, created_at DESC
      LIMIT 100`,
    [user.userId],
  );

  return (
    <main className="min-h-screen bg-black pb-24 text-white">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/10 bg-black/90 px-4 py-3 backdrop-blur">
        <Link href="/account" className="p-1 -ml-1 text-white/70 hover:text-white">
          <ArrowLeft size={22} />
        </Link>
        <h1 className="text-base font-black">{t("title")}</h1>
      </header>

      <div className="mx-auto max-w-2xl px-4 py-6">
        {rows.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-8 text-center">
            <PackageSearch className="mx-auto mb-3 text-white/40" size={40} />
            <p className="text-sm font-semibold">{t("nuAiCereriDe")}</p>
            <p className="mt-1 text-xs text-white/50">
              
              {t("potiSolicitaUnRetur")}
            </p>
            <Link
              href="/account/orders"
              className="mt-4 inline-block rounded-xl bg-white/10 px-5 py-2.5 text-xs font-bold hover:bg-white/15"
            >
              {t("viewMyOrders")}
            </Link>
          </div>
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => {
              const reqAt = r.return_requested_at ? new Date(r.return_requested_at).toLocaleDateString(locale) : null;
              const statusKey = RETURN_STATUS_KEY[r.return_status || "requested"];
              const label = statusKey ? t(statusKey) : r.return_status || t("statusRequested");
              return (
                <li
                  key={r.id}
                  className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 dark:border-white/10"
                >
                  <div className="flex items-center justify-between gap-3">
                    <Link href={`/account/orders/${r.id}`} className="text-sm font-bold hover:underline">
                      
                      {t("comanda")}{r.id.slice(0, 8)}
                    </Link>
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                      {label}
                    </span>
                  </div>
                  {reqAt && <p className="mt-1 text-xs text-white/50">{t("requestedOn", { date: reqAt })}</p>}
                  {r.return_reason && (
                    <p className="mt-2 text-xs text-white/70 line-clamp-3">{r.return_reason}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
