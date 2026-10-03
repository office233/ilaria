import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { auditActorLabel, listAuditEntries } from "@/lib/admin/audit-query";
import { logger } from "@/lib/logger";

const RECENT_LIMIT = 8;

/** Ultimele acțiuni de admin (din jurnalul de audit). */
export async function RecentActivity() {
  const t = await getTranslations("adminConsole.dashboard");
  const locale = await getLocale();
  let rows: Awaited<ReturnType<typeof listAuditEntries>>["rows"] = [];
  try {
    rows = (await listAuditEntries({}, { limit: RECENT_LIMIT })).rows;
  } catch (err) {
    logger.warn({ err }, "[admin/dashboard] recent activity failed");
    return null;
  }
  const fmt = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <section className="space-y-2" aria-label={t("recentActivity")}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted">{t("recentActivity")}</h2>
        <Link href="/admin/audit" className="inline-flex min-h-11 items-center text-sm font-medium text-brand">
          {t("viewAll")}
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-card border border-subtle bg-surface p-4 text-sm text-muted">{t("noActivity")}</p>
      ) : (
        <ul className="divide-y divide-subtle rounded-card border border-subtle bg-surface">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <span className="min-w-0">
                <span className="font-mono text-xs text-fg">{r.action}</span>
                <span className="ml-2 text-muted">{auditActorLabel(r)}</span>
              </span>
              <time className="text-xs text-subtle" dateTime={r.created_at}>
                {fmt.format(new Date(r.created_at))}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
