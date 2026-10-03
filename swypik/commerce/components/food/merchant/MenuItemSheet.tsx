"use client";

/** Adăugare / editare articol de meniu (nume, descriere, preț, categorie). */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { Field, Textarea, TextField } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

export type EditableItem = { id?: string; name: string; description: string | null; price_cents: number; category_id: string | null };
export type ItemPayload = { name: string; description?: string; price: number; category_id: string | null };

type Props = {
  item: EditableItem | null;
  categories: { id: string; name: string }[];
  onClose: () => void;
  onSave: (payload: ItemPayload, id?: string) => Promise<string | null>;
};

export default function MenuItemSheet({ item, categories, onClose, onSave }: Props) {
  const t = useTranslations("foodMerchant");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setName(item.name);
    setDescription(item.description ?? "");
    setPrice(item.id ? (item.price_cents / 100).toFixed(2) : "");
    setCategory(item.category_id ?? "");
    setError(null);
  }, [item]);

  const priceNum = Number(price.replace(",", "."));
  const valid = name.trim().length >= 2 && Number.isFinite(priceNum) && priceNum > 0;

  async function save() {
    setBusy(true);
    const err = await onSave(
      { name: name.trim(), description: description.trim() || undefined, price: priceNum, category_id: category || null },
      item?.id,
    );
    setBusy(false);
    if (err) setError(err);
    else onClose();
  }

  return (
    <Sheet
      open={!!item}
      onOpenChange={(o) => !o && onClose()}
      title={item?.id ? t("editItem") : t("addItem")}
      footer={<Button block loading={busy} disabled={!valid} onClick={() => void save()}>{t("save")}</Button>}
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) void save(); }}>
        <TextField label={t("itemName")} value={name} onChange={(e) => setName(e.target.value)} maxLength={160} required />
        <TextField label={t("itemPrice")} value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.,]/g, ""))} inputMode="decimal" required />
        <Field label={t("itemCategory")}>
          {(f) => (
            <Select
              {...f}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              options={[{ value: "", label: t("noCategory") }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
            />
          )}
        </Field>
        <Field label={t("itemDescription")}>
          {(f) => <Textarea {...f} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />}
        </Field>
        {error ? <p role="alert" className="text-sm font-semibold text-danger">{error}</p> : null}
      </form>
    </Sheet>
  );
}
