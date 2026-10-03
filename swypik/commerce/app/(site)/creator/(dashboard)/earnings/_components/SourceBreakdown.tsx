import { useLocale, useTranslations } from "next-intl";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import type { EarningSource } from "@/lib/creator/earnings";
import { formatMoneyCents } from "@/lib/i18n/currency";
import type { Locale } from "@/lib/i18n/config";

const ORDER: EarningSource[] = ["commissions", "missions", "movies", "music", "fund"];

/** Câștiguri pe surse; sursele cu 0 se ascund (comisioanele rămân mereu vizibile). */
export function SourceBreakdown({ bySource, totalCents }: { bySource: Record<EarningSource, number>; totalCents: number }) {
  const t = useTranslations("creatorStudio.earnings");
  const locale = useLocale() as Locale;
  const visible = ORDER.filter((s) => s === "commissions" || bySource[s] !== 0);

  return (
    <Card>
      <CardHeader className="flex-col gap-1">
        <CardTitle>{t("bySourceTitle")}</CardTitle>
        <CardDescription>{t("bySourceBody")}</CardDescription>
      </CardHeader>
      <ul className="space-y-3">
        {visible.map((s) => {
          const cents = bySource[s];
          const pct = totalCents > 0 ? Math.max(0, Math.min(100, Math.round((cents / totalCents) * 100))) : 0;
          return (
            <li key={s}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-fg">{t(`source.${s}`)}</span>
                <span className="text-sm font-semibold tabular-nums text-fg">{formatMoneyCents(cents, "RON", locale)}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
