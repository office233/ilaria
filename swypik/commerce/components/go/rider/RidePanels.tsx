"use client";

/** Panourile ecranului de cursă: căutare, bon final, anulată. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Car } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import RatingForm from "../RatingForm";
import { useGoFormat } from "../format";
import type { RideDetail } from "../types";

export function SearchingPanel({ requestedAt, onCancel }: { requestedAt: string; onCancel: () => void }) {
  const t = useTranslations("go");
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.parse(requestedAt);
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [requestedAt]);
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <span className="relative flex h-16 w-16 items-center justify-center">
        <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-brand-soft motion-reduce:animate-none" />
        <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-brand text-brand-fg">
          <Car aria-hidden className="h-6 w-6" />
        </span>
      </span>
      <p className="text-sm text-muted tabular-nums" aria-live="polite">
        {t("search.elapsed", { sec: elapsed })}
      </p>
      <Button variant="secondary" block onClick={onCancel}>
        {t("search.cancelFree")}
      </Button>
    </div>
  );
}

export function ReceiptPanel({ ride, rated, onRated }: { ride: RideDetail; rated: boolean; onRated: () => void }) {
  const t = useTranslations("go");
  const f = useGoFormat();
  return (
    <div className="space-y-4">
      <Card variant="muted" className="text-center">
        <p className="text-sm text-muted">{t("receipt.total")}</p>
        <p className="text-3xl font-bold text-fg">{f.money(ride.final_fare_cents ?? ride.estimated_fare_cents, ride.currency)}</p>
        <p className="mt-1 text-xs text-muted">
          {[
            ride.distance_km ? t("distanceKm", { km: f.km(ride.distance_km) }) : null,
            ride.duration_min ? t("durationMin", { min: ride.duration_min }) : null,
            ride.payment_method === "card" ? t("payCard") : t("payCash"),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </Card>
      {rated ? (
        <p className="text-center text-sm text-success">{t("receipt.rateThanks")}</p>
      ) : (
        <RatingForm rideId={ride.id} prompt={t("receipt.ratePrompt")} onDone={onRated} />
      )}
      <Button asChild variant="secondary" block>
        <Link href="/go">{t("receipt.another")}</Link>
      </Button>
    </div>
  );
}

export function CancelledPanel({ ride }: { ride: RideDetail }) {
  const t = useTranslations("go");
  const f = useGoFormat();
  const fee = ride.cancel_fee_cents ?? 0;
  const reasonKey = ride.cancel_reason === "no_driver" || ride.cancel_reason === "no_driver_timeout" ? "cancelledNoDriver" : null;
  return (
    <div className="space-y-3 text-center">
      {reasonKey ? <p className="text-sm text-fg">{t(`receipt.${reasonKey}`)}</p> : null}
      <p className="text-sm text-muted">
        {fee > 0
          ? t(ride.cancel_fee_status === "owed" ? "receipt.cancelledFeeOwed" : "receipt.cancelledFee", {
              fee: f.money(fee, ride.currency),
            })
          : t("receipt.cancelledFree")}
      </p>
      <Button asChild block>
        <Link href="/go">{t("receipt.another")}</Link>
      </Button>
    </div>
  );
}
