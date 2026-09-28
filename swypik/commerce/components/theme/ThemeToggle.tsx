"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { Monitor, Moon, Sun } from "lucide-react";
import { THEME_PREFERENCES, type ThemePreference } from "@/lib/theme/theme-color";
import { cn } from "@/lib/ui/cn";

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

/**
 * Alegerea temei: Luminoasă · Întunecată · Sistem (salvată local).
 * Suprafețele imersive rămân întunecate indiferent de alegere.
 */
export default function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations("appMenu.theme");
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current: ThemePreference = mounted && (theme === "light" || theme === "dark") ? theme : "system";

  return (
    <div
      role="radiogroup"
      aria-label={t("label")}
      className={cn("grid grid-cols-3 gap-1 rounded-control bg-surface-2 p-1", className)}
    >
      {THEME_PREFERENCES.map((pref) => {
        const Icon = ICONS[pref];
        const active = mounted && current === pref;
        return (
          <button
            key={pref}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(pref)}
            className={cn(
              "flex min-h-11 items-center justify-center gap-1.5 rounded-[calc(var(--radius-md)-4px)] text-xs font-semibold text-muted transition-colors duration-fast",
              active && "bg-surface text-fg shadow-elev-1",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {t(pref)}
          </button>
        );
      })}
    </div>
  );
}
