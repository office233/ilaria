"use client";

import { useEffect, useState } from "react";
import { Search, ShoppingBag, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { IconButton } from "@/components/ui/IconButton";
import { Field, Input } from "@/components/ui/Input";
import { ListItem } from "@/components/ui/ListItem";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { pickerApi, type TaggableProductDto } from "@/lib/upload/api";

const DEBOUNCE_MS = 250;

/** Eticheta de produs: doar produse eligibile pentru feed (altfel clipul ar fi ascuns). */
export function ProductPicker(props: {
  productId: string | null;
  productTitle: string | null;
  overlaySec: number;
  maxSec: number | null;
  onSelect: (p: { id: string; title: string } | null) => void;
  onOverlay: (sec: number) => void;
}) {
  const t = useTranslations("videoUpload.product");
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<TaggableProductDto[] | null>(null);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setItems(null);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      pickerApi
        .products(query, ctl.signal)
        .then(setItems)
        .catch(() => setItems([]));
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [open, query]);

  return (
    <div className="space-y-2">
      {props.productId ? (
        <>
          <ListItem
            icon={ShoppingBag}
            title={props.productTitle ?? t("tagged")}
            subtitle={t("taggedHint")}
            trailing={
              <IconButton label={t("remove")} onClick={() => props.onSelect(null)}>
                <X aria-hidden />
              </IconButton>
            }
          />
          <Field label={t("overlayAt")} hint={t("overlayHint")}>
            {(f) => (
              <Input
                {...f}
                type="number"
                inputMode="numeric"
                min={0}
                max={props.maxSec ?? undefined}
                value={props.overlaySec}
                onChange={(e) => props.onOverlay(Math.max(0, Number(e.target.value) || 0))}
                className="w-28"
              />
            )}
          </Field>
        </>
      ) : (
        <ListItem icon={ShoppingBag} title={t("add")} subtitle={t("addHint")} onClick={() => setOpen(true)} />
      )}

      <Sheet open={open} onOpenChange={setOpen} title={t("sheetTitle")}>
        <div className="space-y-3 pt-1">
          <Input
            autoFocus
            leadingIcon={<Search aria-hidden />}
            placeholder={t("search")}
            aria-label={t("search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {items === null ? (
            query.trim().length >= 2 ? (
              <div className="space-y-2">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : (
              <p className="px-1 text-sm text-muted">{t("typeToSearch")}</p>
            )
          ) : items.length === 0 ? (
            <EmptyState icon={ShoppingBag} title={t("empty")} description={t("emptyHint")} />
          ) : (
            <div className="divide-y divide-subtle">
              {items.map((p) => (
                <ListItem
                  key={p.id}
                  leading={
                    p.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image_url} alt="" className="h-10 w-10 rounded-control object-cover" />
                    ) : undefined
                  }
                  icon={p.image_url ? undefined : ShoppingBag}
                  title={p.title}
                  subtitle={format.number(p.price_cents / 100, { style: "currency", currency: p.currency.trim() })}
                  onClick={() => {
                    props.onSelect({ id: p.id, title: p.title });
                    setOpen(false);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </Sheet>
    </div>
  );
}
