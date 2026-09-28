"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowDownRight, ArrowUpRight, ChevronRight, Inbox } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PanelHeading } from "@/components/seller/PanelHeading";
import { OrderStateBadge } from "@/components/seller/orders/OrderStateBadge";
import { formatSellerDate, formatSellerMoney, shortOrderId } from "@/components/seller/format";
import type { SellerDashboardData } from "@/lib/seller/dashboard";
import { OnboardingCard } from "./OnboardingCard";

function Stat({ label, value, hint, href }: { label: string; value: string; hint?: ReactNode; href?: string }) {
  const inner = (
    <Card className="h-full" padding="md">
      <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{label}</p>
      <p className="mt-1 text-2xl font-bold text-fg">{value}</p>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
      {inner}
    </Link>
  ) : (
    inner
  );
}

export function SellerDashboard({ data }: { data: SellerDashboardData }) {
  const t = useTranslations("sellerPanel.dashboard");
  const locale = useLocale();
  const money = (c: number) => formatSellerMoney(locale, c, data.currency);
  const { sales } = data;
  const trend = sales.salesPrev30Cents > 0 ? Math.round(((sales.sales30Cents - sales.salesPrev30Cents) / sales.salesPrev30Cents) * 100) : null;

  return (
    <div className="space-y-4">
      <PanelHeading
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button asChild size="sm">
            <Link href="/seller/products?new=1">{t("addProduct")}</Link>
          </Button>
        }
      />

      {data.onboarding ? <OnboardingCard onboarding={data.onboarding} /> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t("sales30")}
          value={money(sales.sales30Cents)}
          hint={
            trend === null ? (
              t("orders30", { count: sales.orders30 })
            ) : (
              <span className={trend >= 0 ? "inline-flex items-center gap-1 text-success" : "inline-flex items-center gap-1 text-danger"}>
                {trend >= 0 ? <ArrowUpRight className="h-3 w-3" aria-hidden /> : <ArrowDownRight className="h-3 w-3" aria-hidden />}
                {t("trend", { pct: Math.abs(trend) })}
              </span>
            )
          }
        />
        <Stat label={t("net30")} value={money(sales.net30Cents)} hint={t("net30Hint")} />
        <Stat label={t("todo")} value={String(data.orders.todo)} hint={t("todoHint")} href="/seller/orders?tab=todo" />
        <Stat label={t("available")} value={money(data.balance.availableCents)} hint={t("onHold", { amount: money(data.balance.onHoldCents) })} href="/seller/payouts" />
        <Stat label={t("activeProducts")} value={String(data.products.active)} href="/seller/products" />
        <Stat label={t("outOfStock")} value={String(data.products.outOfStock)} hint={t("outOfStockHint")} href="/seller/products" />
        <Stat label={t("shipped")} value={String(data.orders.shipped)} href="/seller/orders?tab=shipped" />
        <Stat label={t("issues")} value={String(data.orders.issues)} href="/seller/orders?tab=issues" />
      </div>

      <Card padding="none">
        <CardHeader className="mb-0 px-4 pt-4">
          <CardTitle>{t("recentOrders")}</CardTitle>
          <Link href="/seller/orders" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand">
            {t("seeAll")} <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
        </CardHeader>
        {data.recentOrders.length === 0 ? (
          <EmptyState icon={Inbox} title={t("noOrders")} description={t("noOrdersHint")} />
        ) : (
          <ul className="divide-y divide-subtle">
            {data.recentOrders.map((o) => (
              <li key={o.order_id}>
                <Link href={`/seller/orders?open=${o.order_id}`} className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-surface-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-fg">#{shortOrderId(o.order_id)}</span>
                    <span className="block truncate text-xs text-muted">
                      {formatSellerDate(locale, o.created_at)} · {o.items.map((i) => `${i.quantity}× ${i.title}`).join(", ")}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block text-sm font-semibold text-fg">{formatSellerMoney(locale, o.total_cents, o.currency)}</span>
                    <OrderStateBadge state={o.state} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
