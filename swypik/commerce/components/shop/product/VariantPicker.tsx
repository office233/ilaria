"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/ui/cn";

export type PickerVariant = {
  id: string;
  name: string;
  color: string | null;
  size: string | null;
  image: string | null;
  stock: number;
};

type Props = {
  variants: PickerVariant[];
  selectedId: string | null;
  onSelect: (variantId: string) => void;
};

const chip =
  "inline-flex min-h-[2.75rem] min-w-[2.75rem] items-center justify-center rounded-control border px-4 text-sm font-medium transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

function chipState(active: boolean, disabled: boolean) {
  if (active) return "border-brand bg-brand-soft text-brand-soft-fg";
  if (disabled) return "border-subtle bg-surface-2 text-subtle line-through";
  return "border-subtle bg-surface text-fg hover:border-strong";
}

/**
 * Alegerea variantei: culoare (cu miniatură) → mărime; dacă variantele nu au
 * atribute culoare/mărime, se afișează direct numele lor. Variantele fără stoc
 * rămân vizibile, dar dezactivate.
 */
export function VariantPicker({ variants, selectedId, onSelect }: Props) {
  const t = useTranslations("shopBuyer.product");
  const selected = variants.find((v) => v.id === selectedId) ?? null;
  const colors = Array.from(new Set(variants.map((v) => v.color).filter((c): c is string => Boolean(c))));
  const hasSizes = variants.some((v) => v.size);

  if (colors.length === 0 && !hasSizes) {
    return (
      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-fg">{t("chooseVariant")}</legend>
        <div className="flex flex-wrap gap-2">
          {variants.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={v.id === selectedId}
              disabled={v.stock <= 0}
              onClick={() => onSelect(v.id)}
              className={cn(chip, chipState(v.id === selectedId, v.stock <= 0))}
            >
              {v.name}
            </button>
          ))}
        </div>
      </fieldset>
    );
  }

  const activeColor = selected?.color ?? colors[0] ?? null;
  const sizesForColor = variants.filter((v) => (colors.length ? v.color === activeColor : true) && v.size);

  const pickColor = (color: string) => {
    const same = variants.filter((v) => v.color === color);
    const keepSize = same.find((v) => v.size && v.size === selected?.size && v.stock > 0);
    const target = keepSize ?? same.find((v) => v.stock > 0) ?? same[0];
    if (target) onSelect(target.id);
  };

  return (
    <div className="space-y-4">
      {colors.length > 0 ? (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-fg">
            {t("chooseColor")}: <span className="font-normal text-muted">{activeColor}</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {colors.map((color) => {
              const sample = variants.find((v) => v.color === color && v.image) ?? null;
              const soldOut = variants.filter((v) => v.color === color).every((v) => v.stock <= 0);
              return (
                <button
                  key={color}
                  type="button"
                  aria-pressed={color === activeColor}
                  aria-label={color}
                  onClick={() => pickColor(color)}
                  className={cn(chip, sample ? "p-1" : "", chipState(color === activeColor, soldOut))}
                >
                  {sample?.image ? (
                    <Image src={sample.image} alt="" width={40} height={40} className="h-10 w-10 rounded-control object-cover" />
                  ) : (
                    color
                  )}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      {sizesForColor.length > 0 ? (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-fg">
            {t("chooseSize")}: <span className="font-normal text-muted">{selected?.size ?? ""}</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {sizesForColor.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={v.id === selectedId}
                disabled={v.stock <= 0}
                onClick={() => onSelect(v.id)}
                className={cn(chip, chipState(v.id === selectedId, v.stock <= 0))}
              >
                {v.size}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}
