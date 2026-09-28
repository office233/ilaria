"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { isEnabledClient } from "@/lib/feature-flags-client";
import { ecosystemModules } from "@/lib/nav/visibility";
import { cn } from "@/lib/ui/cn";

/**
 * Modulele ecosistemului (din lib/nav/modules.ts, doar cele cu flag ON).
 * `layout="strip"`: rând orizontal scrollabil; `layout="grid"`: grilă 4 coloane.
 */
export default function EcosystemBar({
  layout = "strip",
  className,
}: {
  layout?: "strip" | "grid";
  className?: string;
}) {
  const t = useTranslations("appMenu");
  const modules = ecosystemModules(isEnabledClient);
  if (modules.length === 0) return null;

  return (
    <nav aria-label={t("modules")} className={className}>
      <ul
        className={cn(
          layout === "grid"
            ? "grid grid-cols-4 gap-x-2 gap-y-4"
            : "no-scrollbar flex gap-3 overflow-x-auto px-gutter [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]",
        )}
      >
        {modules.map((m) => {
          const Icon = m.icon;
          return (
            <li key={m.id} className={layout === "strip" ? "shrink-0" : undefined}>
              <Link
                href={m.route}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-control py-1 text-center focus-visible:outline-none focus-visible:ring-2",
                  layout === "grid" ? "w-full" : "w-[4.5rem]",
                )}
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-card bg-brand-soft text-brand-soft-fg">
                  <Icon className="h-6 w-6" aria-hidden />
                </span>
                <span className="line-clamp-2 text-xs font-medium leading-tight text-fg">{t(`items.${m.labelKey}`)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
