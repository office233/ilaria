"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Banknote,
  CircleDot,
  Clapperboard,
  Coins,
  FileText,
  Music,
  TrendingUp,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/ui/cn";
import type { CreatorNavIcon } from "../nav";

const ICONS: Record<CreatorNavIcon, LucideIcon> = {
  barChart3: BarChart3,
  upload: Upload,
  clapperboard: Clapperboard,
  music: Music,
  fileText: FileText,
  trendingUp: TrendingUp,
  coins: Coins,
  banknote: Banknote,
  circleDot: CircleDot,
};

export type SidebarNavItem = { href: string; icon: CreatorNavIcon; label: string };

function isActive(pathname: string, href: string): boolean {
  if (href === "/creator") return pathname === "/creator";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Sidebar desktop; rutele /creator nu au prefix de limbă → next/link simplu. */
export default function SidebarNav({ items }: { items: SidebarNavItem[] }) {
  const pathname = usePathname() ?? "";
  return (
    <nav className="flex-1 space-y-1 overflow-y-auto p-3">
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = isActive(pathname, item.href);
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
    </nav>
  );
}
