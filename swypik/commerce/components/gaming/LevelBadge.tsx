"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/ui/cn";
import type { LevelProgress } from "@/lib/gaming/level-math";

type LevelBadgeProps = {
  badge: Pick<LevelProgress, "level" | "xp" | "progress" | "nextLevelXp">;
  /** `inline` = small pill (profiles, comments); `bar` = pill + progress bar. */
  variant?: "inline" | "bar";
  className?: string;
};

/**
 * Level badge for profiles. Data: getLevelBadge()/getLevelBadges() in
 * lib/gaming/level.ts (server) or GET /api/gaming/profile (own account).
 */
export default function LevelBadge({ badge, variant = "inline", className }: LevelBadgeProps) {
  const t = useTranslations("gaming");
  const pill = (
    <Badge tone="brand" className={cn(variant === "inline" && className)}>
      {t("level.short", { level: badge.level })}
    </Badge>
  );
  if (variant === "inline") return pill;

  const pct = Math.round(badge.progress * 100);
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted">
        {pill}
        <span>
          {badge.nextLevelXp === null
            ? t("level.max")
            : t("level.toNext", { remaining: Math.max(0, badge.nextLevelXp - badge.xp), next: badge.level + 1 })}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={t("level.progressLabel")}
      >
        <div className="h-full rounded-full bg-brand transition-[width] duration-base" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
