"use client";

import { useTranslations } from "next-intl";
import { Brain, Gamepad2, PlayCircle, ShoppingBag, Upload } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { DAILY_XP_CAP, XP_RULES } from "@/lib/gaming/config";

const ROWS = [
  { key: "trivia", icon: Brain, xp: XP_RULES.trivia.maxPerDay },
  { key: "arcade", icon: Gamepad2, xp: XP_RULES.arcade.maxPerRound },
  { key: "watch", icon: PlayCircle, xp: XP_RULES.watchDaily.xp },
  { key: "upload", icon: Upload, xp: XP_RULES.firstUpload.xp },
  { key: "purchase", icon: ShoppingBag, xp: XP_RULES.firstPurchase.xp },
] as const;

/** "How to earn XP" — values come from XP_RULES so copy and payouts never drift. */
export default function XpGuide() {
  const t = useTranslations("gaming");
  return (
    <Card className="space-y-3">
      <CardTitle>{t("earn.title")}</CardTitle>
      <ul className="space-y-2">
        {ROWS.map(({ key, icon: Icon, xp }) => (
          <li key={key} className="flex min-h-11 items-center gap-3 text-sm">
            <Icon className="h-5 w-5 shrink-0 text-subtle" aria-hidden />
            <span className="min-w-0 flex-1 text-fg">
              {t(`earn.${key}`, { minViews: XP_RULES.watchDaily.minViews })}
            </span>
            <span className="shrink-0 font-semibold text-brand">{t("earn.xp", { xp })}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-subtle">{t("earn.dailyCap", { cap: DAILY_XP_CAP })}</p>
    </Card>
  );
}
