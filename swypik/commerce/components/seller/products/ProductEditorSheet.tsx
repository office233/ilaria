"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { Field, TextField, Textarea } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { sellerApi, sellerErrorKey } from "@/components/seller/api";
import { formatSellerMoney } from "@/components/seller/format";
import { SELLER_PRODUCT_MAX_IMAGES, SELLER_PRODUCT_MAX_VARIANTS } from "@/lib/seller/config";
import {
  COURIERS,
  PRODUCT_STATUSES,
  draftFromProduct,
  draftToCreatePayload,
  draftToUpdatePayload,
  emptyDraft,
  netAfterCommission,
  validateDraft,
  type ApiProduct,
  type ProductDraft,
} from "./form-model";
import { ProductImagesField } from "./ProductImagesField";
import { VariantsField } from "./VariantsField";
import { CategoryField } from "./CategoryField";

const API_ERRORS = ["compare_below_price", "price_below_cost", "invalid_shipping_days", "validation_error", "rate_limited", "not_found"] as const;

type Props = {
  /** null = închis; "new" = produs nou; altfel id-ul produsului editat. */
  target: string | null;
  currency: string;
  commissionBps: number;
  onClose: () => void;
  onSaved: () => void;
};

export function ProductEditorSheet({ target, currency, commissionBps, onClose, onSaved }: Props) {
  const t = useTranslations("sellerPanel.products.editor");
  const locale = useLocale();
  const [draft, setDraft] = useState<ProductDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNew = target === "new";

  useEffect(() => {
    setError(null);
    if (!target) return setDraft(null);
    if (target === "new") return setDraft(emptyDraft());
    setDraft(null);
    void sellerApi<{ product: ApiProduct }>(`/api/seller/products/${target}`).then((res) => {
      if (res.ok) setDraft(draftFromProduct(res.data.product));
      else setError(t("loadError"));
    });
  }, [target, t]);

  const set = <K extends keyof ProductDraft>(k: K, v: ProductDraft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  async function save() {
    if (!draft) return;
    const invalid = validateDraft(draft);
    if (invalid) return setError(t(`invalid.${invalid}`));
    setSaving(true);
    setError(null);
    const res = isNew
      ? await sellerApi("/api/seller/products", { method: "POST", body: draftToCreatePayload(draft, currency) })
      : await sellerApi(`/api/seller/products/${target}`, { method: "PATCH", body: draftToUpdatePayload(draft) });
    setSaving(false);
    if (!res.ok) return setError(t(sellerErrorKey(res.error, API_ERRORS)));
    onSaved();
  }

  const priceCents = draft ? Math.round(Number(draft.price.replace(",", ".")) * 100) : 0;
  const net = Number.isFinite(priceCents) && priceCents > 0 ? netAfterCommission(priceCents, commissionBps) : null;

  return (
    <Sheet
      open={target !== null}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={isNew ? t("createTitle") : t("editTitle")}
      footer={
        <div className="space-y-2">
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Button block loading={saving} disabled={!draft} onClick={() => void save()}>
            {isNew ? t("create") : t("save")}
          </Button>
        </div>
      }
    >
      {!draft ? (
        <div className="space-y-3">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          <TextField label={t("title")} value={draft.title} onChange={(e) => set("title", e.target.value)} required maxLength={200} />
          <Field label={t("description")}>
            {(f) => <Textarea {...f} rows={4} value={draft.description} onChange={(e) => set("description", e.target.value)} maxLength={5000} />}
          </Field>
          <ProductImagesField images={draft.images} max={SELLER_PRODUCT_MAX_IMAGES} onChange={(v) => set("images", v)} />
          <CategoryField
            title={draft.title}
            description={draft.description}
            category={draft.category}
            taxonomySlug={draft.taxonomySlug}
            onChange={(v) => setDraft((d) => (d ? { ...d, ...v } : d))}
          />
          <div className="grid grid-cols-2 gap-3">
            <TextField label={t("price", { currency })} inputMode="decimal" value={draft.price} onChange={(e) => set("price", e.target.value)} required />
            <TextField label={t("compareAt")} inputMode="decimal" value={draft.compareAt} onChange={(e) => set("compareAt", e.target.value)} />
            <TextField label={t("stock")} inputMode="numeric" value={draft.stock} onChange={(e) => set("stock", e.target.value)} required />
            <TextField label={t("sku")} value={draft.sku} onChange={(e) => set("sku", e.target.value)} />
          </div>
          {net !== null ? (
            <p className="rounded-control bg-surface-2 px-3 py-2 text-sm text-muted">
              {t("net", { net: formatSellerMoney(locale, net, currency), pct: commissionBps / 100 })}
            </p>
          ) : null}
          <TextField label={t("brand")} value={draft.brand} onChange={(e) => set("brand", e.target.value)} />
          <VariantsField variants={draft.variants} max={SELLER_PRODUCT_MAX_VARIANTS} onChange={(v) => set("variants", v)} />
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-fg">{t("shipping")}</legend>
            <div className="grid grid-cols-2 gap-3">
              <TextField label={t("shippingCost")} inputMode="decimal" value={draft.shippingCost} onChange={(e) => set("shippingCost", e.target.value)} />
              <Field label={t("courier")}>
                {(f) => (
                  <Select
                    {...f}
                    value={draft.courier}
                    placeholder={t("courierNone")}
                    onChange={(e) => set("courier", e.target.value as ProductDraft["courier"])}
                    options={COURIERS.map((c) => ({ value: c, label: t(`couriers.${c}`) }))}
                  />
                )}
              </Field>
              <TextField label={t("daysMin")} inputMode="numeric" value={draft.shippingDaysMin} onChange={(e) => set("shippingDaysMin", e.target.value)} />
              <TextField label={t("daysMax")} inputMode="numeric" value={draft.shippingDaysMax} onChange={(e) => set("shippingDaysMax", e.target.value)} />
            </div>
          </fieldset>
          {!isNew ? (
            <Field label={t("status")}>
              {(f) => (
                <Select
                  {...f}
                  value={draft.status}
                  onChange={(e) => set("status", e.target.value as ProductDraft["status"])}
                  options={PRODUCT_STATUSES.map((s) => ({ value: s, label: t(`statuses.${s}`) }))}
                />
              )}
            </Field>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
