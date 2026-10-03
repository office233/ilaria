"use client";

import { useEffect, useState } from "react";
import { CarTaxiFront, Package } from "lucide-react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useGoFormat } from "../format";
import type { DriverOffer } from "./useDriverHeartbeat";

type Props = {
  offer: DriverOffer;
  busy: boolean;
  onRespond: (accept: boolean) => void;
  onExpired: () => void;
};

/** Oferta primită: countdown pe expires_at (server), accept/refuz. */
export default function OfferCard({ offer, busy, onRespond, onExpired }: Props) {
  const t = useTranslations("goDriver");
  const f = useGoFormat();
  const expiresAt = Date.parse(offer.expires_at);
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));

  useEffect(() => {
    const iv = setInterval(() => {
      const s = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setLeft(s);
      if (s <= 0) onExpired();
    }, 1000);
    return () => clearInterval(iv);
  }, [expiresAt, onExpired]);

  const isRide = offer.kind === "ride";
  const Icon = isRide ? CarTaxiFront : Package;
  return (
    <Card variant="elevated" className="space-y-3 border-2 border-brand" role="alert">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold text-fg">
          <Icon aria-hidden className="h-5 w-5" />
          {isRide ? t("offer.newRide") : t("offer.newOrder")}
        </h2>
        <Badge tone={left <= 10 ? "danger" : "info"} className="font-mono tabular-nums">
          {t("offer.secondsLeft", { sec: left })}
        </Badge>
      </div>
      <dl className="space-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="shrink-0 text-muted">{t("offer.pickup")}</dt>
          <dd className="min-w-0 text-fg">{isRide ? offer.pickup_address : `${offer.merchant_name} · ${offer.pickup_address ?? ""}`}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-muted">{isRide ? t("offer.destination") : t("offer.delivery")}</dt>
          <dd className="min-w-0 text-fg">{offer.delivery_address}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-muted">{isRide ? t("offer.fare") : t("offer.earning")}</dt>
          <dd className="font-semibold text-fg">{f.money(offer.delivery_fee_cents, offer.currency)}</dd>
        </div>
      </dl>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" size="lg" disabled={busy} onClick={() => onRespond(false)}>
          {t("offer.decline")}
        </Button>
        <Button size="lg" loading={busy} onClick={() => onRespond(true)}>
          {t("offer.accept")}
        </Button>
      </div>
    </Card>
  );
}
