"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Menu } from "lucide-react";
import { Sheet } from "@/components/ui/Sheet";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/ui/cn";
import { dashboardIcon } from "./dashboard-icons";

export type MobileDashboardNavItem = {
  href: string;
  label: string;
  icon: string;
};

type Props = {
  title: string;
  section: string;
  /** Clasă (token) pentru partea evidențiată din titlu, ex. `text-brand`. */
  accentClassName?: string;
  items: MobileDashboardNavItem[];
  /** Etichete explicite; implicit din `dashboardNav`. */
  openMenuLabel?: string;
  /** Păstrat pentru compatibilitate — butonul de închidere vine din Sheet (`ui.close`). */
  closeMenuLabel?: string;
  menuLabel?: string;
};

function isActive(pathname: string, href: string, all: MobileDashboardNavItem[]): boolean {
  // Rădăcina panoului (ex. /seller) e activă doar exact; altfel câștigă potrivirea cea mai lungă.
  const matches = all.filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const best = matches.sort((a, b) => b.href.length - a.href.length)[0];
  return best?.href === href;
}

/** Meniul panourilor de rol pe mobil: buton ☰ + bottom sheet cu intrările. */
export default function MobileDashboardNav({
  title,
  section,
  accentClassName = "text-brand",
  items,
  openMenuLabel,
  menuLabel,
}: Props) {
  const t = useTranslations("dashboardNav");
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);

  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      trigger={
        <IconButton variant="secondary" label={openMenuLabel ?? t("openMenu")}>
          <Menu aria-hidden />
        </IconButton>
      }
      title={
        <span>
          <span className="block text-xs font-semibold uppercase tracking-wide text-subtle">{menuLabel ?? t("menu")}</span>
          {title} {section ? <span className={accentClassName}>{section}</span> : null}
        </span>
      }
    >
      <nav className="space-y-1 pb-2">
        {items.map((item) => {
          const Icon = dashboardIcon(item.icon);
          const active = isActive(pathname, item.href, items);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-12 items-center gap-3 rounded-control px-4 text-sm font-semibold transition-colors duration-fast",
                active ? "bg-brand-soft text-brand-soft-fg" : "text-fg hover:bg-surface-2",
              )}
            >
              <Icon className="h-5 w-5 shrink-0" aria-hidden />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </Sheet>
  );
}
