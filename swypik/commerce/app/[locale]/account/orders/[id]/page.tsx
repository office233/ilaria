import Image from "next/image";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { redirect } from "@/lib/i18n/navigation";
import { ExternalLink, MapPin, Package } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { OrderPrice } from "@/components/shop/OrderPrice";
import { OrderReviewButton } from "@/components/shop/reviews/OrderReviewButton";
import { MessageButton } from "@/components/messenger/MessageButton";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { Link } from "@/lib/i18n/navigation";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { getBuyerOrder, orderStatusKey, orderStatusTone } from "@/lib/shop/orders";
import { isEnabled } from "@/lib/feature-flags";
import OrderReturnButton from "./OrderReturnButton";

export const dynamic = "force-dynamic";

const RETURNABLE = new Set(["delivered", "fulfilled"]);

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, id } = await params;
  const t = await getTranslations({ locale, namespace: "shopBuyer.orders" });
  return { title: t("detailTitle", { number: id.slice(0, 8).toUpperCase() }), robots: { index: false, follow: false } };
}

export default async function OrderDetailPage({ params }: Props) {
  const { locale: raw, id } = await params;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const user = await getAuthUser();
  if (!user.userId) return redirect({ href: `/account?redirect=/account/orders/${encodeURIComponent(id)}`, locale });
  const order = await getBuyerOrder(user.userId, id);
  if (!order) notFound();

  const [t, ts, format] = await Promise.all([
    getTranslations({ locale, namespace: "shopBuyer.orders" }),
    getTranslations({ locale, namespace: "shopBuyer.summary" }),
    getFormatter({ locale }),
  ]);
  const price = (cents: number, negative = false) => <OrderPrice cents={cents} currency={order.currency} negative={negative} />;
  const addr = order.shipping;

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader back="/account/orders" title={t("detailTitle", { number: order.id.slice(0, 8).toUpperCase() })} />
      <main className="mx-auto max-w-2xl space-y-4 px-gutter py-4">
        <Card padding="md" className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs text-muted">{t("placedOn", { date: format.dateTime(new Date(order.createdAt), { dateStyle: "long", timeStyle: "short" }) })}</p>
            {order.trackingNumber ? <p className="mt-1 text-xs text-muted">{t("trackingNumber", { number: order.trackingNumber })}</p> : null}
          </div>
          <Badge tone={orderStatusTone(order.status)}>{t(`status_${orderStatusKey(order.status)}`)}</Badge>
        </Card>

        <Card padding="none">
          <ul className="divide-y divide-subtle">
            {order.items.map((it) => (
              <li key={it.id} className="space-y-2 px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-control bg-surface-2">
                    {it.image ? (
                      <Image src={it.image} alt="" fill sizes="56px" className="object-cover" />
                    ) : (
                      <Package className="m-4 h-6 w-6 text-subtle" aria-hidden />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    {it.productId ? (
                      <Link href={`/product/${it.productId}`} className="line-clamp-2 text-sm font-medium text-fg hover:underline">
                        {it.title}
                      </Link>
                    ) : (
                      <p className="line-clamp-2 text-sm font-medium text-fg">{it.title}</p>
                    )}
                    <p className="text-xs text-muted">{t("qtyTimes", { qty: it.quantity })} {price(it.unitCents)}</p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-fg">{price(it.lineCents)}</span>
                </div>
                {order.canReview && it.productId ? (
                  <OrderReviewButton productId={it.productId} productTitle={it.title} reviewed={it.reviewed} />
                ) : null}
              </li>
            ))}
          </ul>
        </Card>

        <Card padding="md">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">{ts("subtotal")}</dt>
              <dd className="tabular-nums">{price(order.subtotalCents)}</dd>
            </div>
            {order.discountCents > 0 ? (
              <div className="flex justify-between text-success">
                <dt>{t("discount")}</dt>
                <dd className="tabular-nums">{price(order.discountCents, true)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between">
              <dt className="text-muted">{ts("shipping")}</dt>
              <dd className="tabular-nums">{order.shippingCents === 0 ? ts("shippingFree") : price(order.shippingCents)}</dd>
            </div>
            {order.taxCents > 0 ? (
              <div className="flex justify-between">
                <dt className="text-muted">{t("tax")}</dt>
                <dd className="tabular-nums">{price(order.taxCents)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-subtle pt-3 text-base font-semibold">
              <dt>{ts("total")}</dt>
              <dd className="tabular-nums">{price(order.totalCents)}</dd>
            </div>
          </dl>
        </Card>

        {addr?.line1 ? (
          <Card padding="md" className="flex gap-3">
            <MapPin className="h-5 w-5 shrink-0 text-muted" aria-hidden />
            <div className="text-sm">
              <p className="font-medium text-fg">{t("shippingTo")}</p>
              <p className="text-muted">{[addr.name, addr.line1, [addr.postal_code, addr.city].filter(Boolean).join(" "), addr.country].filter(Boolean).join(", ")}</p>
            </div>
          </Card>
        ) : null}

        {order.trackingUrl && /^https:\/\//.test(order.trackingUrl) ? (
          <Button asChild variant="secondary" block>
            <a href={order.trackingUrl} target="_blank" rel="noopener noreferrer">
              {t("trackOrder")}
              <ExternalLink aria-hidden className="h-4 w-4" />
            </a>
          </Button>
        ) : null}

        <MessageButton entry={{ kind: "order", id: order.id }} labelKey="contactSeller" block />

        {/* Returul e în spatele FEATURE_RETURNS: cu flag-ul oprit POST-ul dă 410, deci nu arătăm butonul. */}
        {isEnabled("returns") && RETURNABLE.has(order.status) ? (
          order.lookupToken ? (
            <OrderReturnButton orderId={order.id} lookupToken={order.lookupToken} />
          ) : (
            <p className="text-center text-xs text-muted">{t("returnHelp")}</p>
          )
        ) : null}
      </main>
    </div>
  );
}
