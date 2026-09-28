"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { CheckCircle2, Circle, ChevronRight } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import type { SellerOnboarding } from "@/lib/seller/onboarding";

/** Checklist de pornire (dispare când pașii obligatorii sunt gata). */
export function OnboardingCard({ onboarding }: { onboarding: SellerOnboarding }) {
  const t = useTranslations("sellerPanel.onboarding");
  if (onboarding.complete) return null;
  const pct = Math.round((onboarding.requiredDone / onboarding.requiredTotal) * 100);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("progress", { done: onboarding.requiredDone, total: onboarding.requiredTotal })}</CardDescription>
        </div>
      </CardHeader>
      <div className="mb-3 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
      </div>
      <ul className="divide-y divide-subtle">
        {onboarding.steps.map((s) => {
          const Icon = s.done ? CheckCircle2 : Circle;
          const body = (
            <>
              <Icon className={s.done ? "h-5 w-5 shrink-0 text-success" : "h-5 w-5 shrink-0 text-subtle"} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-fg">{t(`steps.${s.id}.title`)}</span>
                <span className="block text-xs text-muted">{t(`steps.${s.id}.${s.done ? "done" : "todo"}`)}</span>
              </span>
              {s.optional ? <Badge tone="neutral">{t("optional")}</Badge> : null}
              {s.href && !s.done ? <ChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden /> : null}
            </>
          );
          return (
            <li key={s.id}>
              {s.href && !s.done ? (
                <Link href={s.href} className="flex min-h-12 items-center gap-3 py-2">
                  {body}
                </Link>
              ) : (
                <div className="flex min-h-12 items-center gap-3 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
