"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { activeNavHref, type AdminNavGroup } from "@/lib/admin/nav";
import { cn } from "@/lib/ui/cn";

/** Lista de navigare (grupată pe module) — aceeași pe desktop și în sertarul mobil. */
export function AdminNavList({
  groups,
  pathname,
  onNavigate,
}: {
  groups: AdminNavGroup[];
  pathname: string;
  onNavigate?: () => void;
}) {
  const t = useTranslations("adminShell");
  const active = activeNavHref(pathname, groups);
  return (
    <nav aria-label={t("navLabel")} className="space-y-4">
      {groups.map((group) => (
        <div key={group.id}>
          <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-subtle">
            {t(`nav.section.${group.id}`)}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = item.href === active;
              return (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors duration-fast",
                      isActive ? "bg-brand-soft text-brand-soft-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="truncate">{t(`nav.item.${item.id}`)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
