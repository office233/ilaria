"use client";

import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import type { VariantDraft } from "./form-model";

type Props = { variants: VariantDraft[]; max: number; onChange: (v: VariantDraft[]) => void };

/** Variante (mărime, culoare…): fiecare cu preț și stoc propriu; goale = moștenesc prețul produsului. */
export function VariantsField({ variants, max, onChange }: Props) {
  const t = useTranslations("sellerPanel.products.editor");
  const update = (i: number, patch: Partial<VariantDraft>) => onChange(variants.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-fg">{t("variants")}</p>
        {variants.length < max ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange([...variants, { title: "", sku: "", price: "", stock: "" }])}>
            <Plus className="h-4 w-4" aria-hidden /> {t("addVariant")}
          </Button>
        ) : null}
      </div>
      {variants.length === 0 ? <p className="text-xs text-muted">{t("variantsHint")}</p> : null}
      <ul className="space-y-2">
        {variants.map((v, i) => (
          <li key={v.id ?? `new-${i}`} className="grid grid-cols-2 gap-2 rounded-control border border-subtle p-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
            <Input aria-label={t("variantTitle")} placeholder={t("variantTitle")} value={v.title} onChange={(e) => update(i, { title: e.target.value })} className="col-span-2 sm:col-span-1" />
            <Input aria-label={t("sku")} placeholder={t("sku")} value={v.sku} onChange={(e) => update(i, { sku: e.target.value })} />
            <Input aria-label={t("variantPrice")} placeholder={t("variantPrice")} inputMode="decimal" value={v.price} onChange={(e) => update(i, { price: e.target.value })} />
            <Input aria-label={t("stock")} placeholder={t("stock")} inputMode="numeric" value={v.stock} onChange={(e) => update(i, { stock: e.target.value })} />
            <IconButton label={t("removeVariant")} onClick={() => onChange(variants.filter((_, j) => j !== i))} className="justify-self-end">
              <Trash2 aria-hidden />
            </IconButton>
          </li>
        ))}
      </ul>
    </div>
  );
}
