"use client";

/** Livrarea Food activă a curierului (restaurată după reload). */
import { useState } from "react";
import { Home, Phone, Store } from "lucide-react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import type { ActiveDeliveryJob } from "@/lib/rides/driver-job";
import { goErrorKey, goFetch, useGoFormat } from "../format";
import NavLinks from "./NavLinks";

export default function ActiveDeliveryPanel({ job, onChanged }: { job: ActiveDeliveryJob; onChanged: () => void }) {
  const t = useTranslations("goDriver");
  const f = useGoFormat();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const update = async (status: "picked_up" | "delivered") => {
    setBusy(true);
    const r = await goFetch(`/api/local-orders/${job.order_id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
    setBusy(false);
    if (!r.ok) toast({ title: t(goErrorKey(r.error)), tone: "danger" });
    onChanged();
  };

  const pickedUp = job.status === "picked_up" || job.status === "delivering";
  // Navigare spre restaurant până la ridicare, apoi spre client.
  const target = pickedUp
    ? job.delivery_lat != null && job.delivery_lng != null ? { lat: Number(job.delivery_lat), lng: Number(job.delivery_lng) } : null
    : job.pickup_lat != null && job.pickup_lng != null ? { lat: Number(job.pickup_lat), lng: Number(job.pickup_lng) } : null;
  const phone = pickedUp ? job.customer_phone : job.merchant_phone;
  return (
    <Card className="space-y-3">
      <h2 className="text-base font-semibold text-fg">{t("delivery.title", { number: job.order_number })}</h2>
      <p className="flex items-center gap-2 text-sm text-fg">
        <Store aria-hidden className="h-4 w-4 text-muted" />
        {job.merchant_name}
        {job.pickup_address ? ` · ${job.pickup_address}` : ""}
      </p>
      <p className="flex items-center gap-2 text-sm text-fg">
        <Home aria-hidden className="h-4 w-4 text-muted" />
        {job.customer_first_name ? `${job.customer_first_name} · ` : ""}
        {job.delivery_address}
      </p>
      {target ? <NavLinks lat={target.lat} lng={target.lng} /> : null}
      {phone ? (
        <Button asChild variant="secondary" block>
          <a href={`tel:${phone}`}>
            <Phone aria-hidden className="h-4 w-4" />
            {pickedUp ? t("delivery.callCustomer") : t("delivery.callMerchant")}
          </a>
        </Button>
      ) : null}
      {job.cash_to_collect_cents > 0 ? (
        <p className="rounded-control bg-warning-soft p-2 text-sm text-fg">
          {t("ride.collect", { amount: f.money(job.cash_to_collect_cents, job.currency) })}
        </p>
      ) : null}
      {pickedUp ? (
        <Button block size="lg" loading={busy} onClick={() => void update("delivered")}>
          {t("delivery.delivered")}
        </Button>
      ) : (
        <Button block size="lg" loading={busy} disabled={job.status !== "ready"} onClick={() => void update("picked_up")}>
          {job.status === "ready" ? t("delivery.pickedUp") : t("delivery.waitingKitchen")}
        </Button>
      )}
    </Card>
  );
}
