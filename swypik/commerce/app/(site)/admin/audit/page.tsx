/**
 * Admin — jurnalul de audit (read-only): fiecare acțiune de admin, cine
 * (admin numit / mașină; rândurile istorice pot avea ERP), asupra cui, când. Filtre: tip de acțiune,
 * actor (email/username), țintă (id exact).
 */
import { getLocale, getTranslations } from "next-intl/server";
import { ScrollText } from "lucide-react";
import { AdminPage, LinkTabs, Pager } from "@/components/admin/AdminPage";
import { AdminTable } from "@/components/admin/AdminTable";
import { AdminForbidden } from "@/components/admin/AdminForbidden";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { requireAdminPage } from "@/lib/admin/guard";
import {
  AUDIT_PAGE_SIZE,
  auditActorLabel,
  listAuditActionPrefixes,
  listAuditEntries,
  type AuditFilters,
  type AuditRow,
} from "@/lib/admin/audit-query";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const DETAILS_PREVIEW_CHARS = 160;

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; actor?: string; target?: string; page?: string }>;
}) {
  if (!(await requireAdminPage("audit"))) return <AdminForbidden />;
  const t = await getTranslations("adminAudit");
  const tc = await getTranslations("adminConsole.audit");
  const locale = await getLocale();
  const sp = await searchParams;
  const filters: AuditFilters = {
    action: (sp.action ?? "").trim().slice(0, 64) || undefined,
    actor: (sp.actor ?? "").trim().slice(0, 320) || undefined,
    target: (sp.target ?? "").trim().slice(0, 64) || undefined,
  };
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  let data: { rows: AuditRow[]; total: number } | null = null;
  let prefixes: string[] = [];
  try {
    [data, prefixes] = await Promise.all([
      listAuditEntries(filters, { limit: AUDIT_PAGE_SIZE, offset: (page - 1) * AUDIT_PAGE_SIZE }),
      listAuditActionPrefixes(),
    ]);
  } catch (err) {
    logger.error({ err }, "[admin/audit] failed to load audit log");
  }

  const href = (next: { action?: string | null; page?: number }) => {
    const u = new URLSearchParams();
    const action = next.action === undefined ? filters.action : next.action;
    if (action) u.set("action", action);
    if (filters.actor) u.set("actor", filters.actor);
    if (filters.target) u.set("target", filters.target);
    if (next.page && next.page > 1) u.set("page", String(next.page));
    const qs = u.toString();
    return `/admin/audit${qs ? `?${qs}` : ""}`;
  };
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / AUDIT_PAGE_SIZE));
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" });

  return (
    <AdminPage title={t("pageTitle")} description={t("pageSubtitle")}>
      <form method="get" action="/admin/audit" className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
        {filters.action ? <input type="hidden" name="action" value={filters.action} /> : null}
        <Input name="actor" defaultValue={filters.actor ?? ""} placeholder={tc("actorPlaceholder")} aria-label={t("thActor")} />
        <Input name="target" defaultValue={filters.target ?? ""} placeholder={tc("targetPlaceholder")} aria-label={t("thTarget")} />
        <Button type="submit" variant="secondary">{tc("filter")}</Button>
      </form>

      <LinkTabs
        label={t("thAction")}
        active={filters.action ?? ""}
        tabs={[
          { id: "", label: t("allActions"), href: href({ action: null, page: 1 }) },
          ...prefixes.map((p) => ({ id: p, label: p, href: href({ action: p, page: 1 }) })),
        ]}
      />

      {data === null ? (
        <p role="alert" className="rounded-card bg-danger-soft p-4 text-sm text-danger">{t("loadError")}</p>
      ) : (
        <>
          <p className="text-sm text-muted">{t("pageOf", { page, totalPages, total: data.total })}</p>
          <AdminTable
            rows={data.rows}
            rowKey={(r) => r.id}
            caption={t("pageTitle")}
            empty={<EmptyState icon={ScrollText} title={t("empty")} />}
            columns={[
              {
                key: "action",
                header: t("thAction"),
                primary: true,
                cell: (r) => (
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold text-fg">{r.action}</p>
                    <time className="text-xs text-subtle" dateTime={r.created_at}>{fmt.format(new Date(r.created_at))}</time>
                  </div>
                ),
              },
              {
                key: "actor",
                header: t("thActor"),
                cell: (r) => (
                  <span className="flex flex-wrap items-center gap-1">
                    <span className="truncate">{auditActorLabel(r)}</span>
                    {r.actor_kind !== "admin_user" ? <Badge size="sm" tone="warning">{tc(`kind.${r.actor_kind}`)}</Badge> : null}
                  </span>
                ),
              },
              {
                key: "target",
                header: t("thTarget"),
                cell: (r) => (r.target_type ? `${r.target_type}${r.target_id ? ` · ${r.target_id}` : ""}` : "—"),
              },
              { key: "ip", header: t("thIp"), cell: (r) => r.ip ?? "—" },
              {
                key: "details",
                header: t("thDetails"),
                cell: (r) => {
                  const json = JSON.stringify(r.details ?? {});
                  return (
                    <code className="block max-w-xs truncate text-xs text-muted" title={json}>
                      {json === "{}" ? "—" : json.slice(0, DETAILS_PREVIEW_CHARS)}
                    </code>
                  );
                },
              },
            ]}
          />
        </>
      )}

      <Pager
        page={page}
        totalPages={totalPages}
        hrefFor={(p) => href({ page: p })}
        labels={{ previous: t("previousPage"), next: t("nextPage"), status: `${page} / ${totalPages}` }}
      />
    </AdminPage>
  );
}
