"use client";

/** Căutare + bucătării (chip-uri) + sortare + „Deschis acum” pentru /food. */
import { Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/ui/cn";
import { haptic } from "@/lib/haptic";
import { CUISINE_CHIP_IDS } from "@/lib/merchants/cuisines";
import { MERCHANT_SORTS, type MerchantSort } from "@/lib/food/merchant-list-options";
import { CUISINE_ICONS, useCuisineLabel } from "./cuisine-ui";

export type FoodFilterState = { q: string; cuisine: string | null; sort: MerchantSort; openNow: boolean };

type Props = {
  value: FoodFilterState;
  onChange: (next: FoodFilterState) => void;
  hasGeo: boolean;
};

const chip = "inline-flex h-11 shrink-0 snap-start items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition active:scale-95";

export default function FoodFilters({ value, onChange, hasGeo }: Props) {
  const t = useTranslations("foodHub");
  const cuisineLabel = useCuisineLabel();
  const set = (patch: Partial<FoodFilterState>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-2 pb-2">
      <div className="px-gutter">
        <Input
          type="search"
          inputMode="search"
          value={value.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchPlaceholder")}
          maxLength={80}
          leadingIcon={<Search aria-hidden />}
          trailing={
            value.q ? (
              <IconButton label={t("clearSearch")} size="sm" onClick={() => set({ q: "" })}>
                <X aria-hidden />
              </IconButton>
            ) : undefined
          }
        />
      </div>
      <div className="flex snap-x gap-2 overflow-x-auto px-gutter scrollbar-none" role="group" aria-label={t("cuisinesLabel")}>
        <button
          type="button"
          aria-pressed={value.openNow}
          onClick={() => {
            haptic("tap");
            set({ openNow: !value.openNow });
          }}
          className={cn(chip, value.openNow ? "bg-brand text-brand-fg" : "bg-surface-2 text-muted")}
        >
          {t("openNow")}
        </button>
        {CUISINE_CHIP_IDS.map((id) => {
          const Icon = CUISINE_ICONS[id];
          const active = value.cuisine === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                haptic("tap");
                set({ cuisine: active ? null : id });
              }}
              className={cn(chip, active ? "bg-brand text-brand-fg" : "bg-surface-2 text-muted")}
            >
              {Icon ? <Icon size={16} aria-hidden /> : null}
              {cuisineLabel(id) ?? id}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 px-gutter">
        <label htmlFor="food-sort" className="shrink-0 text-sm text-muted">
          {t("sortLabel")}
        </label>
        <div className="min-w-0 flex-1">
        <Select
          id="food-sort"
          value={value.sort}
          onChange={(e) => set({ sort: e.target.value as MerchantSort })}
          options={MERCHANT_SORTS.filter((s) => s !== "distance" || hasGeo).map((s) => ({ value: s, label: t(`sort.${s}`) }))}
        />
        </div>
      </div>
    </div>
  );
}
