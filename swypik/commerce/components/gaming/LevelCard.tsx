"use client";

import { useTranslations } from "next-intl";
import { Flame, LogIn, Trophy } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import Link from "next/link";
import type { LevelProgress } from "@/lib/gaming/level-math";
import LevelBadge from "./LevelBadge";

export type GamingProfile = LevelProgress & { triviaStreakDays: number };
export type ProfileState = { status: "loading" } | { status: "guest" } | { status: "error" } | { status: "ready"; profile: GamingProfile };

/** Hub header card: level + progress for accounts, sign-in CTA for guests (guests play, but earn no XP). */
export default function LevelCard({ state, loginHref }: { state: ProfileState; loginHref: string }) {
  const t = useTranslations("gaming");

  if (state.status === "loading") return <Skeleton className="h-24 w-full rounded-card" />;

  if (state.status === "guest" || state.status === "error") {
    return (
      <Card className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
          <LogIn className="h-5 w-5" aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-sm text-muted">{t("signIn.body")}</p>
        <Button asChild size="sm">
          <Link href={loginHref}>{t("signIn.cta")}</Link>
        </Button>
      </Card>
    );
  }

  const { profile } = state;
  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
          <Trophy className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-fg">{t("level.title", { level: profile.level })}</p>
          <p className="text-sm text-muted">{t("level.xp", { xp: profile.xp })}</p>
        </div>
        {profile.triviaStreakDays > 0 && (
          <span className="flex items-center gap-1 text-sm font-semibold text-warning">
            <Flame className="h-4 w-4" aria-hidden />
            {t("level.streak", { days: profile.triviaStreakDays })}
          </span>
        )}
      </div>
      <LevelBadge badge={profile} variant="bar" />
    </Card>
  );
}
