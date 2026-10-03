"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Inbox, Search } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { useToast } from "@/components/ui/Toast";
import { PanelHeading } from "@/components/seller/PanelHeading";
import { sellerApi, sellerErrorKey } from "@/components/seller/api";
import type { SellerOrderAction, SellerOrderTab } from "@/lib/seller/fulfilment";
import { OrderCard } from "./OrderCard";
import { OrderSheet } from "./OrderSheet";
import PrintAwbModal from "./PrintAwbModal";
import type { ShipInput } from "./ShipForm";
import { ORDER_ERRORS, type OrderCounts, type SellerOrderRow } from "./types";

const TABS: SellerOrderTab[] = ["todo", "shipped", "done", "issues", "all"];
type ListResponse = { orders: SellerOrderRow[]; hasMore: boolean; counts: OrderCounts };

function isTab(v: string | null): v is SellerOrderTab {
  return v !== null && (TABS as string[]).includes(v);
}

export function SellerOrders() {
  const t = useTranslations("sellerPanel.orders");
  const { toast } = useToast();
  const params = useSearchParams();
  const [tab, setTab] = useState<SellerOrderTab>(isTab(params.get("tab")) ? (params.get("tab") as SellerOrderTab) : "all");
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [orders, setOrders] = useState<SellerOrderRow[] | null>(null);
  const [counts, setCounts] = useState<OrderCounts | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(params.get("open"));
  const [busy, setBusy] = useState<SellerOrderAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    const h = setTimeout(() => setQ(query.trim()), 350);
    return () => clearTimeout(h);
  }, [query]);

  const load = useCallback(
    async (offset = 0) => {
      setLoadError(false);
      const qs = new URLSearchParams({ tab, offset: String(offset) });
      if (q) qs.set("q", q);
      const res = await sellerApi<ListResponse>(`/api/seller/orders?${qs}`);
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      setOrders((prev) => (offset === 0 ? res.data.orders : [...(prev ?? []), ...res.data.orders]));
      setCounts(res.data.counts);
      setHasMore(res.data.hasMore);
    },
    [tab, q],
  );

  useEffect(() => {
    setOrders(null);
    void load(0);
  }, [load]);

  const open = useMemo(() => orders?.find((o) => o.order_id === openId) ?? null, [orders, openId]);

  async function run(action: SellerOrderAction, request: () => ReturnType<typeof sellerApi>) {
    if (!open) return;
    setBusy(action);
    setActionError(null);
    const res = await request();
    setBusy(null);
    if (!res.ok) {
      setActionError(t(sellerErrorKey(res.error, ORDER_ERRORS)));
      return;
    }
    toast({ title: t(`toast.${action}`), tone: "success" });
    await load(0);
  }

  function onAction(action: Exclude<SellerOrderAction, "ship">) {
    if (!open) return;
    const id = open.order_id;
    void run(action, () =>
      action === "refund_return"
        ? sellerApi(`/api/seller/orders/${id}/refund`, { method: "POST" })
        : sellerApi(`/api/seller/orders/${id}/status`, { method: "POST", body: { action } }),
    );
  }

  function onShip(input: ShipInput) {
    if (!open) return;
    const id = open.order_id;
    void run("ship", () => sellerApi(`/api/seller/orders/${id}/awb`, { method: "POST", body: input }));
  }

  return (
    <div className="space-y-4">
      <PanelHeading title={t("title")} subtitle={t("subtitle")} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as SellerOrderTab)}>
        <TabsList aria-label={t("tabsLabel")}>
          {TABS.map((k) => (
            <TabsTrigger key={k} value={k}>
              {t(`tabs.${k}`)}
              {counts && counts[k] > 0 ? <span className="ml-1 text-xs text-subtle">{counts[k]}</span> : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search")}
          aria-label={t("search")}
          className="pl-9"
          type="search"
        />
      </div>

      {loadError ? (
        <ErrorState onRetry={() => void load(0)} />
      ) : orders === null ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-card" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <EmptyState icon={Inbox} title={t(q ? "emptyFiltered" : "empty")} description={t("emptyHint")} />
      ) : (
        <ul className="space-y-2">
          {orders.map((o) => (
            <li key={o.order_id}>
              <OrderCard
                order={o}
                onOpen={() => {
                  setActionError(null);
                  setOpenId(o.order_id);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {hasMore && orders ? (
        <Button variant="secondary" block onClick={() => void load(orders.length)}>
          {t("loadMore")}
        </Button>
      ) : null}

      <OrderSheet
        key={open?.order_id ?? "none"}
        order={open}
        busy={busy}
        error={actionError}
        onClose={() => setOpenId(null)}
        onAction={onAction}
        onShip={onShip}
        onPrint={() => setPrinting(true)}
      />
      <PrintAwbModal order={printing ? open : null} isOpen={printing && !!open} onClose={() => setPrinting(false)} />
    </div>
  );
}
