"use client";

/**
 * /food/orders/[id] — tracking live al unei comenzi Swypik Food, cu statusurile
 * reale din DB (placed → … → delivered / cancelled / rejected), rambursare
 * afișată onest, anulare de către client cât timp restaurantul nu a confirmat.
 * Comenzile guest se deschid cu token-ul din link (?t=) sau din dispozitiv.
 */
import { Link } from "@/lib/i18n/navigation";
import { Bike, Car, MapPin, Phone } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useOrderTracking } from "@/components/food/tracking/useOrderTracking";
import TrackingTimeline from "@/components/food/tracking/TrackingTimeline";
import TrackingMap, { etaMinutes } from "@/components/food/tracking/TrackingMap";
import OrderSummaryCard from "@/components/food/tracking/OrderSummaryCard";
import CancelOrderButton from "@/components/food/tracking/CancelOrderButton";
import { MessageButton } from "@/components/messenger/MessageButton";

const card = "flex items-center gap-3 rounded-card border border-subtle bg-surface p-4";

export default function OrderTrackingClient({ orderId }: { orderId: string }) {
  const t = useTranslations("foodHub");
  const tt = useTranslations("food.tracking");
  const tShell = useTranslations("shell");
  const { order, error, courierPos, token, isFinal, refresh } = useOrderTracking(orderId);

  if (error && !order) {
    return (
      <div className="min-h-dvh bg-canvas">
        <PageHeader back="/food/orders" title={t("trackingTitle")} />
        <ErrorState
          title={error === "no_access" ? tt("noAccess") : error === "not_found" ? tt("notFound") : t("errors.server_error")}
          onRetry={error === "network" ? () => void refresh() : undefined}
        />
      </div>
    );
  }
  if (!order) {
    return (
      <div className="min-h-dvh bg-canvas" aria-busy="true">
        <PageHeader back="/food/orders" title={t("trackingTitle")} />
        <div className="space-y-3 p-gutter">
          <Skeleton className="h-64 rounded-card" />
          <Skeleton className="h-40 rounded-card" />
        </div>
      </div>
    );
  }

  const cancelled = order.status === "cancelled" || order.status === "rejected";
  const eta = isFinal ? null : etaMinutes(order, courierPos);
  const goHref = `/go?dropoff=${encodeURIComponent(order.delivery_address)}${
    order.delivery_lat != null && order.delivery_lng != null ? `&dlat=${order.delivery_lat}&dlng=${order.delivery_lng}` : ""
  }`;

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader
        back="/food/orders"
        title={order.merchant.name}
        subtitle={`#${order.order_number}`}
        actions={eta != null ? <Badge tone="solid">{t("etaShort", { min: eta })}</Badge> : null}
      />
      {!cancelled ? <TrackingMap order={order} courierPos={courierPos} /> : null}

      <main className="mx-auto max-w-lg space-y-4 px-gutter pt-4">
        {cancelled ? (
          <div className="rounded-card bg-danger-soft p-4 text-center" role="status">
            <p className="text-base font-bold text-danger">
              {order.status === "rejected" ? tt("orderRejected") : tt("orderCancelled")}
            </p>
            {order.cancel_reason && order.cancelled_by !== "customer" ? <p className="mt-1 text-sm text-danger">{order.cancel_reason}</p> : null}
          </div>
        ) : (
          <TrackingTimeline status={order.status} dispatchStatus={order.dispatch_status} />
        )}

        {order.courier && !cancelled ? (
          <div className={card}>
            <span className="grid h-11 w-11 place-items-center rounded-full bg-brand-soft text-brand-soft-fg" aria-hidden><Bike size={20} /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-fg">{order.courier.name}</p>
              <p className="text-xs text-muted">{t("yourCourier")}</p>
            </div>
            {order.courier.phone ? (
              <Button asChild size="sm" variant="soft" aria-label={t("callCourier")} className="min-h-11">
                <a href={`tel:${order.courier.phone}`}><Phone size={16} aria-hidden /></a>
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className={card}>
          <MapPin size={18} className="shrink-0 text-muted" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-fg">{order.delivery_address}</p>
            <p className="text-xs text-muted">{t("deliveryAddress")}</p>
          </div>
        </div>

        <OrderSummaryCard order={order} />

        {order.can_cancel ? (
          <CancelOrderButton orderId={order.id} token={token} card={order.payment_method === "card_online"} onDone={() => void refresh()} />
        ) : null}

        {order.merchant.phone && !isFinal ? (
          <Button asChild variant="secondary" block>
            <a href={`tel:${order.merchant.phone}`}><Phone size={16} aria-hidden /> {t("callRestaurant")}</a>
          </Button>
        ) : null}

        <MessageButton entry={{ kind: "food_order", id: order.id }} labelKey="contactRestaurant" block />

        {!cancelled ? (
          <Button asChild variant="ghost" block>
            <Link href={goHref}><Car size={16} aria-hidden /> {t("needRide")}</Link>
          </Button>
        ) : null}

        {order.status === "delivered" || cancelled ? (
          <Button asChild block>
            <Link href={`/food/${order.merchant.slug}?reorder=${order.id}`}>{t("orderAgain")}</Link>
          </Button>
        ) : null}

        {order.status === "delivered" ? (
          <section className="rounded-card border border-subtle bg-surface p-4" aria-label={tShell("discoverFeed")}>
            <p className="text-sm font-bold text-fg">{tShell("discoverAfterDelivery")}</p>
            <p className="mt-1 text-xs text-muted">{tShell("discoverFeedSub")}</p>
            <Button asChild variant="secondary" block className="mt-3">
              <Link href="/?utm_source=food&utm_medium=order_delivered&utm_campaign=cross_sell">{tShell("openFeed")}</Link>
            </Button>
          </section>
        ) : null}
      </main>
    </div>
  );
}
