"use client";

import { Link, usePathname } from "@/lib/i18n/navigation";
import { useTranslations } from "next-intl";
import { BOTTOM_NAV } from "@/lib/nav/modules";
import { activeBottomNavKey, isBottomNavHidden, isImmersiveRoute } from "@/lib/nav/visibility";
import { haptic } from "@/lib/haptic";
import { cn } from "@/lib/ui/cn";

/**
 * Navigarea de jos: Acasă (feed video) · Descoperă · Creează · Inbox · Profil.
 * Înălțimea e tokenul `--nav-h`; spațiul pentru conținut îl rezervă CSS-ul
 * (`html:has([data-bottom-nav])` în globals.css) — fără efecte JS, fără layout shift.
 * Pe rutele imersive (feed) trece pe varianta întunecată.
 */
export default function BottomNav() {
  const pathname = usePathname();
  const t = useTranslations("nav");
  if (isBottomNavHidden(pathname)) return null;
  const activeKey = activeBottomNavKey(pathname);
  const immersive = isImmersiveRoute(pathname);

  return (
    <nav
      data-bottom-nav=""
      data-testid="bottom-nav"
      aria-label={t("mainNavigation")}
      {...(immersive ? { "data-theme": "dark" } : {})}
      className={cn(
        "fixed inset-x-0 bottom-0 z-nav pb-safe-b text-fg",
        immersive ? "bg-black" : "border-t border-subtle bg-surface/95 backdrop-blur-xl",
      )}
    >
      <ul className="mx-auto grid h-nav max-w-lg grid-cols-5 items-center px-1">
        {BOTTOM_NAV.map((item) => {
          const Icon = item.icon;
          const label = t(item.key);
          const active = activeKey === item.key;
          if (item.center) {
            return (
              <li key={item.key} className="flex justify-center">
                <Link
                  href={item.route}
                  onClick={() => haptic("tap")}
                  aria-label={label}
                  className="flex h-11 w-14 items-center justify-center rounded-control bg-brand-gradient text-white shadow-elev-2 transition-transform duration-fast active:scale-95"
                >
                  <Icon className="h-6 w-6" strokeWidth={2.5} aria-hidden />
                </Link>
              </li>
            );
          }
          return (
            <li key={item.key}>
              <Link
                href={item.route}
                onClick={() => haptic("tap")}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-nav w-full flex-col items-center justify-center gap-0.5 transition-colors duration-fast",
                  active ? "text-fg" : "text-muted hover:text-fg",
                )}
              >
                <Icon className="h-6 w-6" strokeWidth={active ? 2.4 : 1.8} aria-hidden />
                <span className={cn("text-xs leading-none", active ? "font-semibold" : "font-medium")}>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
