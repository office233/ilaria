"use client";

/** Alegerea opțiunilor unui produs (mărime, extra) — respectă `required` și `max` per grup. */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import { cn } from "@/lib/ui/cn";
import { haptic } from "@/lib/haptic";
import type { MenuItem } from "@/lib/food/types";
import { choiceId } from "./useCart";

type Props = { item: MenuItem | null; onClose: () => void; onAdd: (item: MenuItem, optionIds: string[]) => void };

export default function OptionPickerSheet({ item, onClose, onAdd }: Props) {
  const t = useTranslations("foodHub");
  const fmt = useFormatPrice();
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => setPicked([]), [item?.id]);

  const options = item?.options ?? [];
  const missing = options.some((o) => o.required && !(o.choices ?? []).some((c) => picked.includes(choiceId(o.name, c))));

  const toggle = (groupIds: string[], max: number, cid: string) => {
    haptic("tap");
    setPicked((prev) => {
      if (prev.includes(cid)) return prev.filter((x) => x !== cid);
      const inGroup = prev.filter((x) => groupIds.includes(x));
      const cleaned = inGroup.length >= max ? prev.filter((x) => x !== inGroup[0]) : prev;
      return [...cleaned, cid];
    });
  };

  return (
    <Sheet
      open={!!item}
      onOpenChange={(o) => !o && onClose()}
      title={item?.name ?? ""}
      description={item?.description ?? undefined}
      footer={
        <Button block disabled={missing} onClick={() => item && onAdd(item, picked)}>
          {missing ? t("chooseRequired") : t("addToCart")}
        </Button>
      }
    >
      <div className="space-y-5">
        {options.map((o) => {
          const groupIds = (o.choices ?? []).map((c) => choiceId(o.name, c));
          return (
            <fieldset key={o.name}>
              <legend className="text-sm font-bold text-fg">
                {o.name}
                {o.required ? <span className="ml-1 text-xs font-semibold text-danger">{t("required")}</span> : null}
              </legend>
              <div className="mt-2 space-y-2">
                {(o.choices ?? []).map((c) => {
                  const cid = choiceId(o.name, c);
                  const active = picked.includes(cid);
                  return (
                    <button
                      key={cid}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggle(groupIds, o.max ?? 1, cid)}
                      className={cn(
                        "flex min-h-11 w-full items-center justify-between rounded-control border px-3.5 text-sm font-semibold transition",
                        active ? "border-brand bg-brand-soft text-brand-soft-fg" : "border-subtle text-fg",
                      )}
                    >
                      <span>{c.name}</span>
                      {c.price_cents ? <span>+{fmt(c.price_cents)}</span> : null}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>
    </Sheet>
  );
}
