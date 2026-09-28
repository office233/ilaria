"use client";

import { Minus, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/ui/cn";

type Props = {
  value: number;
  min?: number;
  max: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  className?: string;
};

/** Selector de cantitate cu ținte de 44px. */
export function QuantityStepper({ value, min = 1, max, onChange, disabled, className }: Props) {
  const t = useTranslations("shopBuyer.common");
  return (
    <div
      className={cn("inline-flex h-11 items-center rounded-control border border-subtle bg-surface", className)}
      role="group"
      aria-label={t("quantity")}
    >
      <IconButton
        label={t("decrease")}
        size="md"
        className="rounded-control"
        disabled={disabled || value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <Minus aria-hidden />
      </IconButton>
      <span className="w-8 text-center text-sm font-semibold tabular-nums text-fg" aria-live="polite">
        {value}
      </span>
      <IconButton
        label={t("increase")}
        size="md"
        className="rounded-control"
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <Plus aria-hidden />
      </IconButton>
    </div>
  );
}
