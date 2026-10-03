"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Archive, Package, Pencil, Plus, Sparkles } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { useToast } from "@/components/ui/Toast";
import { PanelHeading } from "@/components/seller/PanelHeading";
import { sellerApi } from "@/components/seller/api";
import { formatSellerMoney } from "@/components/seller/format";
import { isEnabledClient } from "@/lib/feature-flags-client";
import ViralCatalogModal from "./ViralCatalogModal";
import type { ApiProduct } from "./form-model";
import { ProductEditorSheet } from "./ProductEditorSheet";

const FILTERS = ["all", "active", "draft", "out_of_stock", "archived"] as const;
type Filter = (typeof FILTERS)[number];
const TONE: Record<string, "success" | "neutral" | "warning" | "danger"> = {
  active: "success",
  draft: "neutral",
  out_of_stock: "warning",
  archived: "neutral",
  disabled: "danger",
};
type ListResponse = { products: ApiProduct[]; hasMore: boolean; commissionBps: number; currency: string };

export function SellerProducts() {
  const t = useTranslations("sellerPanel.products");
  const locale = useLocale();
  const { toast } = useToast();
  const params = useSearchParams();
  const [filter, setFilter] = useState<Filter>("all");
  const [list, setList] = useState<ListResponse | null>(null);
  const [error, setError] = useState(false);
  const [target, setTarget] = useState<string | null>(params.get("new") === "1" ? "new" : null);
  const [viral, setViral] = useState(false);

  const load = useCallback(
    async (offset = 0) => {
      setError(false);
      const qs = new URLSearchParams({ offset: String(offset) });
      if (filter !== "all") qs.set("status", filter);
      const res = await sellerApi<ListResponse>(`/api/seller/products?${qs}`);
      if (!res.ok) return setError(true);
      setList((prev) => (offset === 0 || !prev ? res.data : { ...res.data, products: [...prev.products, ...res.data.products] }));
    },
    [filter],
  );
  useEffect(() => {
    setList(null);
    void load(0);
  }, [load]);

  async function archive(id: string) {
    const res = await sellerApi(`/api/seller/products/${id}`, { method: "DELETE" });
    toast(res.ok ? { title: t("archived"), tone: "success" } : { title: t("errors.generic"), tone: "danger" });
    if (res.ok) void load(0);
  }

  const stockOf = (p: ApiProduct) => Number(p.metadata?.available_stock ?? 0);

  return (
    <div className="space-y-4">
      <PanelHeading
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            {isEnabledClient("viralCatalog") ? (
              <Button variant="secondary" size="sm" onClick={() => setViral(true)}>
                <Sparkles className="h-4 w-4" aria-hidden /> {t("viral")}
              </Button>
            ) : null}
            <Button size="sm" onClick={() => setTarget("new")}>
              <Plus className="h-4 w-4" aria-hidden /> {t("add")}
            </Button>
          </>
        }
      />
      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList aria-label={t("filterLabel")}>
          {FILTERS.map((f) => (
            <TabsTrigger key={f} value={f}>
              {t(`filters.${f}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {error ? (
        <ErrorState onRetry={() => void load(0)} />
      ) : !list ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-card" />
          ))}
        </div>
      ) : list.products.length === 0 ? (
        <EmptyState
          icon={Package}
          title={t("emptyTitle")}
          description={t("emptyHint")}
          action={<Button onClick={() => setTarget("new")}>{t("add")}</Button>}
        />
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {list.products.map((p) => (
            <li key={p.id}>
              <Card padding="sm" className="flex items-center gap-3">
                {p.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.image_url} alt="" className="h-16 w-16 shrink-0 rounded-control object-cover" />
                ) : (
                  <span className="grid h-16 w-16 shrink-0 place-items-center rounded-control bg-surface-2 text-subtle">
                    <Package className="h-6 w-6" aria-hidden />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-semibold text-fg">{p.title}</p>
                  <p className="text-sm text-fg">{formatSellerMoney(locale, p.price_cents ?? 0, p.currency ?? list.currency)}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <Badge tone={TONE[p.status] ?? "neutral"}>{t(`statuses.${p.status in TONE ? p.status : "draft"}`)}</Badge>
                    <span className={stockOf(p) > 0 ? "text-xs text-muted" : "text-xs text-warning"}>{t("stock", { count: stockOf(p) })}</span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col">
                  <IconButton label={t("edit")} onClick={() => setTarget(p.id)}>
                    <Pencil aria-hidden />
                  </IconButton>
                  {p.status !== "archived" ? (
                    <IconButton label={t("archive")} onClick={() => void archive(p.id)}>
                      <Archive aria-hidden />
                    </IconButton>
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {list?.hasMore ? (
        <Button variant="secondary" block onClick={() => void load(list.products.length)}>
          {t("loadMore")}
        </Button>
      ) : null}

      <ProductEditorSheet
        target={target}
        currency={list?.currency ?? "RON"}
        commissionBps={list?.commissionBps ?? 0}
        onClose={() => setTarget(null)}
        onSaved={() => {
          toast({ title: target === "new" ? t("created") : t("saved"), tone: "success" });
          setTarget(null);
          void load(0);
        }}
      />
      {viral ? <ViralCatalogModal isOpen={viral} onClose={() => setViral(false)} onProductImported={() => void load(0)} /> : null}
    </div>
  );
}
