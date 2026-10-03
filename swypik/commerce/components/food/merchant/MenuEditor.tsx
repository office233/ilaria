"use client";

/** Editorul de meniu al restaurantului: categorii + articole (CRUD, disponibilitate). */
import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import MenuItemSheet, { type EditableItem, type ItemPayload } from "./MenuItemSheet";

type Item = EditableItem & { id: string; is_available: boolean };
type Section = { id: string | null; name: string | null; items: Item[] };
type Confirm = { kind: "item" | "category"; id: string; name: string };

export default function MenuEditor({ merchantId }: { merchantId: string }) {
  const t = useTranslations("foodMerchant");
  const fmt = useFormatPrice();
  const { toast } = useToast();
  const [sections, setSections] = useState<Section[]>([]);
  const [editing, setEditing] = useState<EditableItem | null>(null);
  const [catOpen, setCatOpen] = useState(false);
  const [catName, setCatName] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const base = `/api/merchants/${merchantId}/menu`;

  const load = useCallback(async () => {
    const res = await fetch(`${base}?all=1`, { cache: "no-store" });
    const data = (await res.json().catch(() => null)) as { menu?: Section[] } | null;
    if (res.ok) setSections(data?.menu ?? []);
  }, [base]);
  useEffect(() => void load(), [load]);

  const send = async (method: string, body?: unknown, qs = ""): Promise<string | null> => {
    const res = await fetch(`${base}${qs}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (res.ok) {
      void load();
      return null;
    }
    // Mesajele de validare ale rutei sunt în română — afișăm un text tradus generic.
    return t(res.status === 429 ? "rateLimited" : "saveFailed");
  };

  const saveItem = (p: ItemPayload, id?: string) =>
    id ? send("PATCH", { item_id: id, ...p }) : send("POST", { ...p, category_id: p.category_id ?? undefined });

  const categories = sections.filter((s): s is Section & { id: string; name: string } => !!s.id && !!s.name).map((s) => ({ id: s.id, name: s.name }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setEditing({ name: "", description: null, price_cents: 0, category_id: categories[0]?.id ?? null })}>
          <Plus size={16} aria-hidden /> {t("addItem")}
        </Button>
        <Button variant="secondary" onClick={() => setCatOpen(true)}>{t("addCategory")}</Button>
      </div>

      {sections.length === 0 ? <EmptyState title={t("menuEmpty")} description={t("menuEmptySub")} /> : null}

      {sections.map((s) => (
        <section key={s.id ?? "other"} className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-fg">{s.name ?? t("otherCategory")}</h3>
            {s.id ? (
              <IconButton label={t("deleteCategory")} onClick={() => setConfirm({ kind: "category", id: s.id as string, name: s.name ?? "" })}>
                <Trash2 aria-hidden />
              </IconButton>
            ) : null}
          </div>
          {s.items.map((it) => (
            <div key={it.id} className="flex items-center gap-2 rounded-card border border-subtle bg-surface p-3">
              <div className="min-w-0 flex-1">
                <p className={`truncate text-sm font-bold ${it.is_available ? "text-fg" : "text-subtle line-through"}`}>{it.name}</p>
                <p className="text-sm text-muted">{fmt(it.price_cents)}</p>
              </div>
              <Switch
                aria-label={t("available", { name: it.name })}
                checked={it.is_available}
                onCheckedChange={(v) => void send("PATCH", { item_id: it.id, is_available: v }).then((e) => e && toast({ title: e, tone: "danger" }))}
              />
              <IconButton label={t("editItem")} onClick={() => setEditing(it)}><Pencil aria-hidden /></IconButton>
              <IconButton label={t("deleteItem")} onClick={() => setConfirm({ kind: "item", id: it.id, name: it.name })}><Trash2 aria-hidden /></IconButton>
            </div>
          ))}
        </section>
      ))}

      <MenuItemSheet item={editing} categories={categories} onClose={() => setEditing(null)} onSave={saveItem} />

      <Dialog
        open={catOpen}
        onOpenChange={setCatOpen}
        title={t("addCategory")}
        footer={
          <Button disabled={catName.trim().length < 1} onClick={() => void send("POST", { type: "category", name: catName.trim() }).then((e) => { if (e) toast({ title: e, tone: "danger" }); else { setCatOpen(false); setCatName(""); } })}>
            {t("save")}
          </Button>
        }
      >
        <Input aria-label={t("categoryName")} placeholder={t("categoryName")} value={catName} maxLength={120} onChange={(e) => setCatName(e.target.value)} />
      </Dialog>

      <Dialog
        open={!!confirm}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={confirm ? t(confirm.kind === "item" ? "confirmDeleteItem" : "confirmDeleteCategory", { name: confirm.name }) : ""}
        footer={
          <Button variant="danger" onClick={() => confirm && void send("DELETE", undefined, `?${confirm.kind === "item" ? "item_id" : "category_id"}=${confirm.id}`).then(() => setConfirm(null))}>
            {t("delete")}
          </Button>
        }
      />
    </div>
  );
}
