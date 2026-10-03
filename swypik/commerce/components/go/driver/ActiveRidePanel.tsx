"use client";

/**
 * Cursa activă a șoferului (restaurată din /api/couriers/active-job la
 * reload): hartă, pasager, navigare, sosit / pornit / finalizat, anulare,
 * „încasează X" pentru cash, rating pasager. Anularea de către pasager vine
 * pe SSE-ul cursei.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import type { ActiveRideJob } from "@/lib/rides/driver-job";
import RideMap, { type LatLng } from "../RideMap";
import RatingForm from "../RatingForm";
import { goErrorKey, goFetch, useGoFormat } from "../format";
import { useRideLive } from "../useRideLive";
import NavLinks from "./NavLinks";

const NEXT: Record<string, { to: "arriving" | "in_progress" | "completed"; label: string } | undefined> = {
  accepted: { to: "arriving", label: "ride.arrived" },
  arriving: { to: "in_progress", label: "ride.start" },
  in_progress: { to: "completed", label: "ride.complete" },
};

type Props = { job: ActiveRideJob; position: LatLng | null; onChanged: () => void };

export default function ActiveRidePanel({ job, position, onChanged }: Props) {
  const t = useTranslations("goDriver");
  const f = useGoFormat();
  const { toast } = useToast();
  const live = useRideLive(job.ride_id);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [rated, setRated] = useState(job.rider_rated);
  const selfCancel = useRef(false);

  // Pasagerul (sau dispeceratul) a anulat / reatribuit: resincronizăm.
  const liveStatus = live.data?.ride.status;
  useEffect(() => {
    if (liveStatus && liveStatus !== job.status) {
      if (liveStatus === "cancelled" && !selfCancel.current) toast({ title: t("ride.cancelledByRider"), tone: "danger" });
      onChanged();
    }
  }, [liveStatus, job.status, onChanged, toast, t]);

  const act = async (url: string, body: unknown) => {
    setBusy(true);
    const r = await goFetch(url, { method: url.endsWith("/pay") ? "POST" : "PATCH", body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) toast({ title: t(goErrorKey(r.error)), tone: "danger" });
    onChanged();
    return r.ok;
  };

  const step = NEXT[job.status];
  const toPickup = job.status === "accepted" || job.status === "arriving";
  const target = toPickup ? { lat: job.pickup_lat, lng: job.pickup_lng } : { lat: job.dropoff_lat, lng: job.dropoff_lng };
  const awaitingCash = job.status === "completed";

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-fg">{t(`ride.status.${job.status}`)}</h2>
        <Badge tone={job.payment_method === "cash" ? "warning" : "success"}>
          {job.payment_method === "cash" ? t("ride.cash") : t("ride.card")}
        </Badge>
      </div>
      <div className="relative h-48 overflow-hidden rounded-control">
        <RideMap
          pickup={{ lat: job.pickup_lat, lng: job.pickup_lng, label: job.pickup_address }}
          dropoff={{ lat: job.dropoff_lat, lng: job.dropoff_lng, label: job.dropoff_address }}
          driver={position}
        />
      </div>
      <dl className="space-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="shrink-0 text-muted">{t("ride.rider")}</dt>
          <dd className="text-fg">{job.rider_first_name ?? t("ride.riderUnknown")}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-muted">{t("offer.pickup")}</dt>
          <dd className="min-w-0 text-fg">{job.pickup_address}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-muted">{t("offer.destination")}</dt>
          <dd className="min-w-0 text-fg">{job.dropoff_address}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-muted">{t("offer.fare")}</dt>
          <dd className="font-semibold text-fg">{f.money(job.final_fare_cents ?? job.estimated_fare_cents, job.currency)}</dd>
        </div>
      </dl>

      {!awaitingCash ? <NavLinks lat={target.lat} lng={target.lng} /> : null}

      {step ? (
        <Button block size="lg" loading={busy} onClick={() => void act(`/api/rides/${job.ride_id}/status`, { status: step.to })}>
          {t(step.label)}
        </Button>
      ) : null}

      {awaitingCash ? (
        <div className="space-y-2 rounded-control bg-warning-soft p-3 text-center">
          <p className="text-sm text-fg">{t("ride.collect", { amount: f.money(job.cash_to_collect_cents, job.currency) })}</p>
          <Button block size="lg" loading={busy} onClick={() => void act(`/api/rides/${job.ride_id}/pay`, { action: "collect_cash" })}>
            {t("ride.collected")}
          </Button>
        </div>
      ) : null}

      {awaitingCash && !rated ? (
        <RatingForm rideId={job.ride_id} prompt={t("ride.rateRider")} onDone={() => setRated(true)} />
      ) : null}

      {job.status === "accepted" || job.status === "arriving" ? (
        <Button variant="ghost" block onClick={() => setConfirmCancel(true)}>
          {t("ride.cancel")}
        </Button>
      ) : null}

      <Dialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={t("ride.cancelTitle")}
        description={t("ride.cancelBody")}
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setConfirmCancel(false)}>
              {t("ride.keep")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                selfCancel.current = true;
                if (await act(`/api/rides/${job.ride_id}/status`, { status: "cancelled", cancel_reason: "other", reason: "driver" })) {
                  setConfirmCancel(false);
                }
              }}
            >
              {t("ride.cancel")}
            </Button>
          </div>
        }
      />
    </Card>
  );
}
