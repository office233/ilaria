"use client";

/**
 * Panoul restaurantului (seller): comenzi live (polling + sunet), acceptă /
 * refuză / gata / anulează cu motiv, caută curier prin API-ul de dispatch,
 * deschis/închis acum, editor de meniu.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Store } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { useMerchantOrders } from "@/components/food/merchant/useMerchantOrders";
import MerchantOrderCard from "@/components/food/merchant/MerchantOrderCard";
import MenuEditor from "@/components/food/merchant/MenuEditor";
import { useFoodError } from "@/components/food/useFoodError";

type Merchant = { id: string; name: string; slug: string; status: string; is_open: boolean; is_open_override: boolean | null; opening_hours: Record<string, unknown> | null };

export default function MerchantPanelClient() {
  const t = useTranslations("foodMerchant");
  const errorText = useFoodError();
  const { toast } = useToast();
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unauthorized" | "error">("loading");
  const { orders, loaded, setStatus, findCourier } = useMerchantOrders(merchantId);
  const merchant = merchants.find((m) => m.id === merchantId) ?? null;

  useEffect(() => {
    fetch("/api/merchants/mine", { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) return setState("unauthorized");
        if (!res.ok) return setState("error");
        const data = (await res.json()) as { merchants?: Merchant[] };
        const list = data.merchants ?? [];
        setMerchants(list);
        setMerchantId(list[0]?.id ?? null);
        setState("ok");
      })
      .catch(() => setState("error"));
  }, []);

  const hasHours = !!merchant?.opening_hours && Object.keys(merchant.opening_hours).length > 0;
  const openNow = merchant?.is_open === true;

  async function toggleOpen() {
    if (!merchant) return;
    // Deschis → închis forțat; închis forțat cu program → revine la program; altfel → deschis acum.
    const next = openNow ? false : hasHours && merchant.is_open_override === false ? null : true;
    const res = await fetch("/api/merchants", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchant_id: merchant.id, is_open_override: next }),
    });
    if (!res.ok) {
      toast({ title: t("saveFailed"), tone: "danger" });
      return;
    }
    // „Deschis acum” se recalculează pe server (program + override).
    const mine = (await fetch("/api/merchants/mine", { cache: "no-store" }).then((r) => r.json()).catch(() => null)) as { merchants?: Merchant[] } | null;
    if (mine?.merchants) setMerchants(mine.merchants);
  }

  const onStatus = async (id: string, status: string, reason?: string) => {
    const code = await setStatus(id, status, reason);
    if (code) toast({ title: errorText(code), tone: "danger" });
  };
  const onFindCourier = async (id: string) => {
    const ok = await findCourier(id);
    toast({ title: ok ? t("courierSearchStarted") : t("courierSearchFailed"), tone: ok ? "success" : "danger" });
  };

  if (state === "loading") return <div className="space-y-3 p-gutter"><Skeleton className="h-14 rounded-card" /><Skeleton className="h-40 rounded-card" /></div>;
  if (state === "unauthorized") {
    return <EmptyState icon={Store} title={t("signInTitle")} description={t("signInSub")} action={<Button asChild><Link href="/seller/login?next=/seller/merchant">{t("signIn")}</Link></Button>} />;
  }
  if (state === "error") return <ErrorState onRetry={() => window.location.reload()} />;
  if (!merchant) {
    return <EmptyState icon={Store} title={t("noMerchantTitle")} description={t("noMerchantSub")} action={<Button asChild><Link href="/food">{t("findYourRestaurant")}</Link></Button>} />;
  }

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader
        back="/seller"
        title={merchant.name}
        subtitle={openNow ? t("openNow") : t("closedNow")}
        actions={<Button size="sm" className="min-h-11" variant={openNow ? "secondary" : "primary"} onClick={() => void toggleOpen()}>{openNow ? t("closeNow") : t("openNowAction")}</Button>}
      />
      <div className="mx-auto max-w-3xl space-y-4 px-gutter pt-4">
        {merchants.length > 1 ? (
          <Select aria-label={t("chooseRestaurant")} value={merchantId ?? ""} onChange={(e) => setMerchantId(e.target.value)} options={merchants.map((m) => ({ value: m.id, label: m.name }))} />
        ) : null}
        {!openNow ? <p className="rounded-control bg-warning-soft px-3 py-2 text-sm font-semibold text-warning">{t("closedNotice")}</p> : null}
        <Tabs defaultValue="orders">
          <TabsList variant="pill">
            <TabsTrigger value="orders">{t("tabOrders", { count: orders.length })}</TabsTrigger>
            <TabsTrigger value="menu">{t("tabMenu")}</TabsTrigger>
          </TabsList>
          <TabsContent value="orders" className="space-y-3 pt-3">
            {!loaded ? <Skeleton className="h-32 rounded-card" /> : orders.length === 0 ? (
              <EmptyState title={t("noActiveOrders")} description={t("noActiveOrdersSub")} />
            ) : (
              orders.map((o) => <MerchantOrderCard key={o.id} o={o} onStatus={onStatus} onFindCourier={onFindCourier} />)
            )}
          </TabsContent>
          <TabsContent value="menu" className="pt-3">
            <MenuEditor merchantId={merchant.id} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
