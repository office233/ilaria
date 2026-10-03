import { CheckCircle2, Clock } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import PurchaseTracker from "@/components/PurchaseTracker";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Link } from "@/lib/i18n/navigation";
import { cn } from "@/lib/ui/cn";
import { OrderPrice } from "../OrderPrice";

export type SuccessOrder = {
  id: string;
  createdAt: string | null;
  totalCents: number | null;
  currency: string;
  customerEmail: string | null;
};

type Props = {
  title: string;
  description: string;
  isPaid: boolean;
  isPending: boolean;
  /** Banca/wallet-ul a respins plata (redirect_status=failed). */
  isFailed?: boolean;
  showDetails: boolean;
  order: SuccessOrder | null;
  items: Array<{ title: string; quantity: number; priceCents: number }>;
  shipping: { name?: string | null; line1?: string | null; city?: string | null } | null;
};

/** Confirmarea după plată (tokeni + primitive). Detaliile apar doar dacă pagina a verificat accesul (PII gate). */
export async function SuccessView({ title, description, isPaid, isPending, isFailed = false, showDetails, order, items, shipping }: Props) {
  const [t, ts, format] = await Promise.all([getTranslations("success"), getTranslations("shopBuyer"), getFormatter()]);
  const badge = isPaid
    ? { label: t("statusPaid"), tone: "success" as const }
    : isFailed
      ? { label: t("statusFailed"), tone: "danger" as const }
      : isPending
      ? { label: t("statusProcessing"), tone: "warning" as const }
      : { label: t("statusVerifying"), tone: "neutral" as const };
  const Icon = isPaid ? CheckCircle2 : Clock;

  return (
    <main className="min-h-dvh bg-canvas px-gutter py-10">
      {isPaid && showDetails && order?.id ? <PurchaseTracker orderId={order.id} /> : null}
      <div className="mx-auto w-full max-w-md space-y-6 text-center">
        <span className={cn("mx-auto flex h-20 w-20 items-center justify-center rounded-full", isPaid ? "bg-success-soft text-success" : isFailed ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning")}>
          <Icon className="h-10 w-10" aria-hidden />
        </span>
        <div>
          <h1 className="text-2xl font-semibold text-fg">{title}</h1>
          <p className="mt-2 text-sm text-muted">{description}</p>
        </div>

        {showDetails && order ? (
          <Card padding="md" className="space-y-4 text-left">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-fg">{ts("orders.orderNumber", { number: order.id.slice(0, 8).toUpperCase() })}</p>
                {order.createdAt ? <p className="text-xs text-muted">{format.dateTime(new Date(order.createdAt), { dateStyle: "long" })}</p> : null}
              </div>
              <Badge tone={badge.tone}>{badge.label}</Badge>
            </div>
            {items.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {items.map((item, idx) => (
                  <li key={idx} className="flex justify-between gap-4">
                    <span className="line-clamp-1 text-fg">{ts("orders.qtyTimes", { qty: item.quantity })} {item.title}</span>
                    <span className="shrink-0 tabular-nums text-muted">
                      <OrderPrice cents={item.priceCents * item.quantity} currency={order.currency} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {order.totalCents != null ? (
              <div className="flex items-center justify-between border-t border-subtle pt-3 font-semibold">
                <span className="text-fg">{isPaid ? t("totalPaid") : t("totalOrder")}</span>
                <span className="text-lg tabular-nums text-fg">
                  <OrderPrice cents={order.totalCents} currency={order.currency} />
                </span>
              </div>
            ) : null}
            {shipping || order.customerEmail ? (
              <div className="space-y-1 border-t border-subtle pt-3 text-sm">
                {shipping ? (
                  <>
                    <p className="text-xs font-medium text-muted">{t("livrareCatre")}</p>
                    <p className="text-fg">{shipping.name}</p>
                    <p className="text-muted">{[shipping.line1, shipping.city].filter(Boolean).join(", ")}</p>
                  </>
                ) : null}
                {order.customerEmail ? <p className="text-muted">{ts("checkout.emailShown", { email: order.customerEmail })}</p> : null}
              </div>
            ) : null}
          </Card>
        ) : null}

        <div className="space-y-3">
          {isFailed ? (
            <Button asChild block size="lg">
              <Link href="/checkout">{t("retryPayment")}</Link>
            </Button>
          ) : null}
          {showDetails && order ? (
            <Button asChild block size="lg">
              <Link href={`/account/orders/${order.id}`}>{t("urmaresteComanda")}</Link>
            </Button>
          ) : null}
          <Button asChild block size="lg" variant="secondary">
            <Link href="/shop">{t("inapoiLaMagazin")}</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
