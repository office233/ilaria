"use client";

import { useEffect, useState } from "react";
import { Pin, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { OrderPrice } from "@/components/shop/OrderPrice";
import { Button } from "@/components/ui/Button";
import { ListItem } from "@/components/ui/ListItem";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { DEFAULT_CURRENCY } from "@/lib/i18n/config";
import type { LiveShopItem } from "@/lib/live/queries";

type HostProduct = { id: string; title: string; image_url: string | null; price_cents: number | null; currency: string | null };

type Props = {
  streamId: string;
  items: LiveShopItem[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onChanged: () => void;
};

/** Gazda: fixează un produs pentru spectatori sau adaugă din magazinul propriu. */
export function StudioProducts({ streamId, items, open, onOpenChange, onChanged }: Props) {
  const t = useTranslations("live.studio");
  const { toast } = useToast();
  const [picking, setPicking] = useState(false);
  const [catalog, setCatalog] = useState<HostProduct[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!picking || catalog) return;
    fetch("/api/live/host-products")
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d: { items?: HostProduct[] }) => setCatalog(d.items ?? []))
      .catch(() => setCatalog([]));
  }, [picking, catalog]);

  const call = async (key: string, url: string, body: unknown) => {
    setBusy(key);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(String(res.status));
      onChanged();
      return true;
    } catch {
      toast({ title: t("productError"), tone: "danger" });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const pin = (item: LiveShopItem) => call(`pin-${item.id}`, `/api/live/streams/${streamId}/pin`, { item_id: item.id });
  const add = async (p: HostProduct) => {
    if (await call(`add-${p.id}`, `/api/live/streams/${streamId}/items`, { product_id: p.id, display_order: items.length })) {
      setPicking(false);
      toast({ title: t("productAdded"), tone: "success" });
    }
  };

  const onList = new Set(items.map((i) => i.product_id));
  const available = (catalog ?? []).filter((p) => !onList.has(p.id));

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setPicking(false);
      }}
      title={picking ? t("addProductTitle") : t("productsTitle")}
      footer={
        picking ? undefined : (
          <Button block variant="secondary" onClick={() => setPicking(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("addProduct")}
          </Button>
        )
      }
    >
      {!picking ? (
        items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{t("noProducts")}</p>
        ) : (
          <ul className="space-y-0.5 pb-2">
            {items.map((it) => (
              <li key={it.id}>
                <ListItem
                  title={it.title ?? it.product_id}
                  subtitle={it.price_cents != null ? <OrderPrice cents={it.price_cents} currency={it.currency || DEFAULT_CURRENCY} /> : undefined}
                  trailing={
                    <Button
                      size="sm"
                      variant={it.is_pinned ? "primary" : "secondary"}
                      loading={busy === `pin-${it.id}`}
                      disabled={it.is_pinned}
                      onClick={() => void pin(it)}
                    >
                      <Pin className="h-4 w-4" aria-hidden />
                      {it.is_pinned ? t("pinned") : t("pin")}
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        )
      ) : catalog === null ? (
        <p className="py-6 text-center text-sm text-muted">{t("loadingProducts")}</p>
      ) : available.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t("noShopProducts")}</p>
      ) : (
        <ul className="space-y-0.5 pb-2">
          {available.map((p) => (
            <li key={p.id}>
              <ListItem
                title={p.title}
                subtitle={p.price_cents != null ? <OrderPrice cents={p.price_cents} currency={p.currency || DEFAULT_CURRENCY} /> : undefined}
                onClick={busy ? undefined : () => void add(p)}
                trailing={<Plus className="h-4 w-4 text-muted" aria-hidden />}
              />
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
