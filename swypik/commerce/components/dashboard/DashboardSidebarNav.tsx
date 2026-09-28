"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/ui/cn";
import { dashboardIcon } from "./dashboard-icons";
import type { MobileDashboardNavItem } from "./MobileDashboardNav";

export type DashboardNavGroup = { id: string; title: string; items: MobileDashboardNavItem[] };

function activeHref(pathname: string, groups: DashboardNavGroup[]): string | null {
  const all = groups.flatMap((g) => g.items);
  const matches = all.filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  return matches.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

/** Sidebar desktop pentru panourile de rol, cu secțiuni; aceleași intrări ca meniul mobil. */
export default function DashboardSidebarNav({ groups }: { groups: DashboardNavGroup[] }) {
  const pathname = usePathname() ?? "";
  const current = activeHref(pathname, groups);
  return (
    <nav className="flex-1 space-y-4 overflow-y-auto p-3">
      {groups.map((g) => (
        <div key={g.id} className="space-y-1">
          <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-subtle">{g.title}</p>
          {g.items.map((item) => {
            const Icon = dashboardIcon(item.icon);
            const active = item.href === current;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-semibold transition-colors duration-fast",
                  active ? "bg-brand-soft text-brand-soft-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                <Icon className="h-5 w-5 shrink-0" aria-hidden />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
