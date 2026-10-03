"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { ChevronLeft, LogOut, Menu } from "lucide-react";
import { navForRole } from "@/lib/admin/nav";
import type { AdminRole } from "@/lib/admin/permissions";
import { IconButton } from "@/components/ui/IconButton";
import { Badge } from "@/components/ui/Badge";
import { Sheet } from "@/components/ui/Sheet";
import { AdminNavList } from "./_shell/AdminNavList";

export type AdminShellIdentity = {
  email: string | null;
  username: string | null;
  role: AdminRole;
  breakGlass: boolean;
};

function IdentityBlock({ identity }: { identity: AdminShellIdentity }) {
  const t = useTranslations("adminShell");
  return (
    <div className="min-w-0 space-y-1">
      <p className="truncate text-sm font-medium text-fg">{identity.email ?? identity.username ?? "—"}</p>
      <div className="flex flex-wrap gap-1">
        <Badge tone="brand" size="sm">{t(`role.${identity.role}`)}</Badge>
        {identity.breakGlass ? <Badge tone="danger" size="sm">{t("breakGlass")}</Badge> : null}
      </div>
    </div>
  );
}

export default function AdminShell({ identity, children }: { identity: AdminShellIdentity; children: ReactNode }) {
  const t = useTranslations("adminShell");
  const pathname = usePathname() ?? "/admin";
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const groups = useMemo(() => navForRole(identity.role), [identity.role]);

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.refresh();
  }

  const storefrontLink = (
    <Link
      href="/"
      className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-muted hover:text-fg"
    >
      <ChevronLeft className="h-4 w-4" aria-hidden />
      {t("storefront")}
    </Link>
  );

  return (
    <div className="flex min-h-dvh bg-canvas text-fg">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-subtle bg-surface md:flex">
        <div className="flex h-header items-center justify-between px-4">
          <Link href="/admin" className="text-base font-bold">{t("title")}</Link>
          <IconButton label={t("logOut")} size="sm" onClick={handleLogout}>
            <LogOut aria-hidden />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <AdminNavList groups={groups} pathname={pathname} />
        </div>
        <div className="space-y-2 border-t border-subtle px-4 py-3">
          <IdentityBlock identity={identity} />
          {storefrontLink}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-header flex h-header items-center justify-between border-b border-subtle bg-surface/95 px-2 pt-safe-t backdrop-blur md:hidden">
          <IconButton label={t("openMenu")} onClick={() => setDrawerOpen(true)}>
            <Menu aria-hidden />
          </IconButton>
          <Link href="/admin" className="truncate text-base font-bold">{t("title")}</Link>
          <IconButton label={t("logOut")} onClick={handleLogout}>
            <LogOut aria-hidden />
          </IconButton>
        </header>

        <Sheet
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          side="left"
          title={t("title")}
          footer={
            <div className="space-y-2">
              <IdentityBlock identity={identity} />
              {storefrontLink}
            </div>
          }
        >
          <AdminNavList groups={groups} pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
        </Sheet>

        <main className="min-w-0 flex-1 overflow-x-hidden pb-safe-b">{children}</main>
      </div>
    </div>
  );
}
