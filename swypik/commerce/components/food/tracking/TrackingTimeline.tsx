"use client";

/** Timeline-ul statusurilor reale ale comenzii (placed → delivered). */
import { Bike, Check, ChefHat, ShoppingBag } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/ui/cn";

const STEPS = ["placed", "accepted", "preparing", "ready", "picked_up", "delivering", "delivered"] as const;

export default function TrackingTimeline({ status, dispatchStatus }: { status: string; dispatchStatus: string | null }) {
  const t = useTranslations("food.tracking");
  const th = useTranslations("foodHub");
  const current = STEPS.indexOf(status as (typeof STEPS)[number]);

  return (
    <ol className="rounded-card border border-subtle bg-surface p-4" aria-label={th("timelineLabel")}>
      {STEPS.map((step, i) => {
        const done = current > i || status === "delivered";
        const active = current === i && status !== "delivered";
        const Icon = step === "preparing" ? ChefHat : step === "picked_up" || step === "delivering" ? Bike : ShoppingBag;
        return (
          <li key={step} className="flex gap-3" aria-current={active ? "step" : undefined}>
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "grid h-7 w-7 shrink-0 place-items-center rounded-full",
                  done || active ? "bg-brand text-brand-fg" : "bg-surface-2 text-subtle",
                )}
              >
                {done ? <Check size={14} aria-hidden /> : active ? <Icon size={14} aria-hidden /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
              </span>
              {i < STEPS.length - 1 ? <span className={cn("w-0.5 flex-1", done ? "bg-brand" : "bg-surface-2")} /> : null}
            </div>
            <div className={i === STEPS.length - 1 ? "" : "pb-4"}>
              <p className={cn("text-sm", active ? "font-bold text-fg" : done ? "font-semibold text-fg" : "text-subtle")}>
                {t(`step_${step}`)}
              </p>
              {active && step === "placed" ? <p className="text-xs text-muted">{th("waitingConfirmation")}</p> : null}
              {active && step === "ready" && dispatchStatus === "no_courier" ? (
                <p className="text-xs text-warning">{th("noCourierYet")}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
