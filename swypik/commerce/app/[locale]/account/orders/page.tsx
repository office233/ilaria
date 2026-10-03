import Image from "next/image";
import type { Metadata } from "next";
import { redirect } from "@/lib/i18n/navigation";
import { ChevronRight, Package } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { OrderPrice } from "@/components/shop/OrderPrice";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { Link } from "@/lib/i18n/navigation";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { listBuyerOrders, orderStatusKey, orderStatusTone } from "@/lib/shop/orders";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "shopBuyer.orders" });
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

export default async function OrdersPage({ params, searchParams }: Props) {
  const { locale: raw } = await params;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const { cursor } = await searchParams;
  const user = await getAuthUser();
  if (!user.userId) return redirect({ href: "/account?redirect=/account/orders", locale });

  const [t, format, page] = await Promise.all([
    getTranslations({ locale, namespace: "shopBuyer.orders" }),
    getFormatter({ locale }),
    listBuyerOrders(user.userId, { cursor, limit: PAGE_SIZE }),
  ]);

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader back="/account" title={t("title")} />
      <main className="mx-auto max-w-2xl px-gutter py-4">
        {page.orders.length === 0 ? (
          <EmptyState
            icon={Package}
            title={t("emptyTitle")}
            description={t("emptyBody")}
            action={
              <Button asChild>
                <Link href="/shop">{t("browse")}</Link>
              </Button>
            }
          />
        ) : (
          <Card padding="none">
            <ul className="divide-y divide-subtle">
              {page.orders.map((o) => (
                <li key={o.id}>
                  <Link href={`/account/orders/${o.id}`} className="flex min-h-[4.5rem] items-center gap-3 px-4 py-3 hover:bg-surface-2">
                    <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-control bg-surface-2">
                      {o.firstImage ? (
                        <Image src={o.firstImage} alt="" fill sizes="48px" className="object-cover" />
                      ) : (
                        <Package className="m-3 h-6 w-6 text-subtle" aria-hidden />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">
                        {t("orderNumber", { number: o.id.slice(0, 8).toUpperCase() })}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {format.dateTime(new Date(o.createdAt), { dateStyle: "medium" })} · {t("itemsCount", { count: o.itemCount })}
                      </span>
                    </span>
                    <span className="flex flex-col items-end gap-1">
                      <span className="text-sm font-semibold tabular-nums text-fg">
                        <OrderPrice cents={o.totalCents} currency={o.currency} />
                      </span>
                      <Badge tone={orderStatusTone(o.status)} size="sm">
                        {t(`status_${orderStatusKey(o.status)}`)}
                      </Badge>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {page.nextCursor ? (
          <div className="mt-4 flex justify-center">
            <Button asChild variant="secondary">
              <Link href={`/account/orders?cursor=${encodeURIComponent(page.nextCursor)}`}>{t("loadMore")}</Link>
            </Button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
