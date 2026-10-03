/**
 * Admin — utilizatori: căutare, filtre de stare, suspendare/ridicare, roluri
 * (cont + rol de admin). Tabel pe desktop, carduri pe telefon.
 */
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { BadgeCheck, Users } from "lucide-react";
import { AdminPage, LinkTabs, Pager } from "@/components/admin/AdminPage";
import { AdminTable } from "@/components/admin/AdminTable";
import { AdminForbidden } from "@/components/admin/AdminForbidden";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { requireAdminPage } from "@/lib/admin/guard";
import { hasPermission, isAdminRole } from "@/lib/admin/permissions";
import {
  isSuspended,
  listAdminUsers,
  parseUserStatus,
  USER_STATUS_FILTERS,
  USERS_PAGE_SIZE,
  type AdminUserRow,
} from "@/lib/admin/users-query";
import { logger } from "@/lib/logger";
import UserActions from "./UserActions";

export const dynamic = "force-dynamic";

const TAB_KEY = { all: "tabAll", active: "tabActive", suspended: "tabSuspended", admin: "tabAdmins" } as const;

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const actor = await requireAdminPage("users.manage");
  if (!actor) return <AdminForbidden />;

  const t = await getTranslations("adminUsers");
  const ts = await getTranslations("adminShell");
  const tc = await getTranslations("adminConsole.users");
  const locale = await getLocale();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 100) || null;
  const status = parseUserStatus(sp.status);
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  let data: { rows: AdminUserRow[]; total: number } | null = null;
  try {
    data = await listAdminUsers({ q, status, page });
  } catch (err) {
    logger.error({ err }, "[admin/users] failed to load users");
  }

  const href = (next: { status?: string; page?: number }) => {
    const u = new URLSearchParams();
    const s = next.status ?? status;
    if (s !== "all") u.set("status", s);
    if (q) u.set("q", q);
    if (next.page && next.page > 1) u.set("page", String(next.page));
    const qs = u.toString();
    return `/admin/users${qs ? `?${qs}` : ""}`;
  };
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / USERS_PAGE_SIZE));
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const canManageAdmins = hasPermission(actor.role, "admins.manage");

  return (
    <AdminPage title={t("pageTitle")} description={data ? t("summaryLine", { total: data.total, page, totalPages }) : undefined}>
      <form method="get" action="/admin/users" className="flex max-w-xl gap-2" role="search">
        <Input name="q" type="search" defaultValue={q ?? ""} placeholder={t("searchPlaceholder")} aria-label={t("searchPlaceholder")} />
        {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
        <Button type="submit">{t("searchBtn")}</Button>
      </form>

      <LinkTabs
        label={tc("statusFilter")}
        active={status}
        tabs={USER_STATUS_FILTERS.map((s) => ({ id: s, label: t(TAB_KEY[s]), href: href({ status: s, page: 1 }) }))}
      />

      {data === null ? (
        <p role="alert" className="rounded-card bg-danger-soft p-4 text-sm text-danger">{t("loadError")}</p>
      ) : (
        <AdminTable
          rows={data.rows}
          rowKey={(u) => u.id}
          caption={t("pageTitle")}
          empty={<EmptyState icon={Users} title={t("noUsersFound")} />}
          columns={[
            {
              key: "user",
              header: t("thUser"),
              primary: true,
              cell: (u) => (
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar src={u.avatar_url ?? undefined} name={u.display_name ?? u.username} size="sm" />
                  <div className="min-w-0">
                    <Link href={`/u/${u.username}`} className="flex items-center gap-1 font-semibold text-fg hover:underline">
                      @{u.username}
                      {u.is_verified ? <BadgeCheck className="h-4 w-4 text-info" aria-label={t("verified")} /> : null}
                    </Link>
                    <p className="truncate text-sm text-muted">{u.email ?? "—"}</p>
                  </div>
                </div>
              ),
            },
            {
              key: "role",
              header: t("thRole"),
              cell: (u) => (
                <span className="flex flex-wrap gap-1">
                  <Badge tone={u.role === "admin" ? "brand" : "neutral"} size="sm">{tc(`accountRole.${u.role}`)}</Badge>
                  {u.role === "admin" && isAdminRole(u.admin_role) ? (
                    <Badge tone="info" size="sm">{ts(`role.${u.admin_role}`)}</Badge>
                  ) : null}
                </span>
              ),
            },
            {
              key: "status",
              header: t("thStatus"),
              cell: (u) =>
                isSuspended(u) ? (
                  <Badge tone="danger" size="sm" title={u.suspension_reason ?? undefined}>{t("suspended")}</Badge>
                ) : (
                  <Badge tone="success" size="sm">{t("active")}</Badge>
                ),
            },
            { key: "videos", header: t("thVideos"), align: "end", cell: (u) => u.videos_count },
            { key: "sessions", header: t("thSessions"), align: "end", cell: (u) => u.active_sessions },
            { key: "created", header: t("thRegistered"), cell: (u) => dateFmt.format(new Date(u.created_at)) },
          ]}
          actions={(u) => (
            <UserActions
              userId={u.id}
              username={u.username}
              role={u.role}
              adminRole={u.admin_role}
              isSuspended={isSuspended(u)}
              canManageAdmins={canManageAdmins}
              isSelf={actor.userId === u.id}
            />
          )}
        />
      )}

      <Pager
        page={page}
        totalPages={totalPages}
        hrefFor={(p) => href({ page: p })}
        labels={{ previous: t("previous"), next: t("next"), status: `${page} / ${totalPages}` }}
      />
    </AdminPage>
  );
}
