"use client";

import { Car, CarFront, Bus, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/ui/cn";
import { useGoFormat } from "../format";
import type { QuoteClass } from "../types";

const ICONS: Record<string, typeof Car> = { economy: Car, comfort: CarFront, van: Bus };
const KNOWN = new Set(["economy", "comfort", "van"]);

type Props = {
  classes: QuoteClass[];
  selected: string | null;
  onSelect: (vehicleClass: string) => void;
};

/** Clasele disponibile la pickup (din pricing_zones) cu tariful estimat. */
export default function ClassPicker({ classes, selected, onSelect }: Props) {
  const t = useTranslations("go");
  const f = useGoFormat();
  return (
    <div role="radiogroup" aria-label={t("chooseClass")} className="space-y-2">
      {classes.map((c) => {
        const Icon = ICONS[c.vehicle_class] ?? Car;
        const active = selected === c.vehicle_class;
        const name = KNOWN.has(c.vehicle_class) ? t(`class.${c.vehicle_class}`) : c.vehicle_class;
        return (
          <button
            key={c.vehicle_class}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(c.vehicle_class)}
            className={cn(
              "flex min-h-[56px] w-full items-center gap-3 rounded-card border px-3 py-2 text-left transition-colors duration-fast",
              active ? "border-brand bg-brand-soft" : "border-subtle bg-surface hover:bg-surface-2",
            )}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-surface-2 text-fg">
              <Icon aria-hidden className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-fg">{name}</span>
              <span className="flex items-center gap-2 text-xs text-muted">
                {c.max_passengers ? (
                  <span className="inline-flex items-center gap-1">
                    <Users aria-hidden className="h-3.5 w-3.5" />
                    {t("seatsCount", { count: c.max_passengers })}
                  </span>
                ) : null}
                <span>{t("eta", { min: c.duration_min, km: f.km(c.distance_km) })}</span>
              </span>
            </span>
            <span className="text-right">
              <span className="block text-base font-bold text-fg">{f.money(c.total_cents, c.currency)}</span>
              {c.surge_multiplier > 1 ? (
                <span className="block text-xs font-medium text-warning">{t("surge", { mult: c.surge_multiplier })}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
