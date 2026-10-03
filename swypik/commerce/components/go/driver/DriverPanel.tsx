"use client";

/**
 * /courier — panoul șoferului Swypik Go (și al curierilor Food):
 * online/offline cu heartbeat, oferte, jobul activ restaurat de pe server
 * (reload-safe), onboarding + documente, câștiguri din ledger.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, QrCode, RadioTower, Wallet } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/ui/PageHeader";
import { IconButton } from "@/components/ui/IconButton";
import { Card } from "@/components/ui/Card";
import { Switch } from "@/components/ui/Switch";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListItem } from "@/components/ui/ListItem";
import { useToast } from "@/components/ui/Toast";
import type { ActiveJob, RideToRate } from "@/lib/rides/driver-job";
import RatingForm from "../RatingForm";
import { goErrorKey, goFetch } from "../format";
import { useDriverHeartbeat } from "./useDriverHeartbeat";
import { alertNewOffer } from "./offer-sound";
import { armAlertAudio } from "../alert-audio";
import OfferCard from "./OfferCard";
import ActiveRidePanel from "./ActiveRidePanel";
import ActiveDeliveryPanel from "./ActiveDeliveryPanel";
import DriverStatusCard, { type DriverMe } from "./DriverStatusCard";

export default function DriverPanel() {
  const t = useTranslations("goDriver");
  const { toast } = useToast();
  const hb = useDriverHeartbeat({ title: t("bgLocation.title"), message: t("bgLocation.message") });
  const [me, setMe] = useState<DriverMe | null>(null);
  const [job, setJob] = useState<ActiveJob | null | undefined>(undefined);
  const [rateRide, setRateRide] = useState<RideToRate | null>(null);
  const [responding, setResponding] = useState(false);
  const [sound, setSound] = useState(true);
  const seen = useRef(new Set<string>());

  const loadJob = useCallback(async () => {
    const r = await goFetch<{ job: ActiveJob | null; rate_ride?: RideToRate | null }>("/api/couriers/active-job");
    setJob(r.ok ? r.data.job : null);
    setRateRide(r.ok ? r.data.rate_ride ?? null : null);
  }, []);

  // iOS: sunetul alertelor se deblochează la primul gest (audit #21).
  useEffect(() => armAlertAudio(), []);

  const loadMe = useCallback(async () => {
    const r = await goFetch<DriverMe>("/api/couriers/me");
    setMe(r.ok ? r.data : { courier: null, documents: [], required_documents: [] });
  }, []);

  useEffect(() => {
    void loadMe();
    void loadJob();
  }, [loadMe, loadJob]);

  const offer = job ? null : hb.offers[0] ?? null;
  useEffect(() => {
    if (offer && !seen.current.has(offer.offer_id)) {
      seen.current.add(offer.offer_id);
      alertNewOffer(sound);
    }
  }, [offer, sound]);

  const respond = async (accept: boolean) => {
    if (!offer) return;
    setResponding(true);
    const url = offer.kind === "ride" ? `/api/rides/${offer.ride_id}/dispatch` : `/api/local-orders/${offer.order_id}/dispatch`;
    const r = await goFetch<{ job?: ActiveJob | null }>(url, { method: "PATCH", body: JSON.stringify({ accept }) });
    setResponding(false);
    hb.dropOffer(offer.offer_id);
    if (!r.ok && accept) toast({ title: t(goErrorKey(r.error)), tone: "danger" });
    if (accept) await loadJob();
  };

  const { dropOffer } = hb;
  const offerId = offer?.offer_id;
  const onExpired = useCallback(() => {
    if (offerId) dropOffer(offerId);
  }, [offerId, dropOffer]);

  const errorKey = hb.error ? `heartbeat.${hb.error}` : null;
  const approved = me?.courier?.verification_status === "approved" && me.courier.active;

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader
        title={t("title")}
        actions={
          <IconButton label={sound ? t("soundOn") : t("soundOff")} onClick={() => setSound((s) => !s)}>
            {sound ? <Bell aria-hidden /> : <BellOff aria-hidden />}
          </IconButton>
        }
      />
      <div className="mx-auto max-w-md space-y-4 px-gutter py-4">
        {me === null ? <Skeleton className="h-20 w-full" /> : <DriverStatusCard me={me} onDocsChanged={() => void loadMe()} />}

        {approved ? (
          <Card className="flex items-center justify-between gap-3">
            <div>
              <p className="text-base font-semibold text-fg">{hb.online ? t("online") : t("offline")}</p>
              <p className="text-xs text-muted">{hb.online ? t("onlineHint") : t("offlineHint")}</p>
            </div>
            <Switch
              checked={hb.online}
              disabled={hb.busy || Boolean(job && hb.online)}
              onCheckedChange={() => void hb.toggle()}
              aria-label={t("toggleOnline")}
            />
          </Card>
        ) : null}

        {errorKey ? (
          <p role="alert" className="rounded-control bg-danger-soft p-3 text-sm text-danger">
            {t(errorKey)}
          </p>
        ) : null}

        {!job && rateRide ? (
          <Card>
            <RatingForm
              rideId={rateRide.ride_id}
              prompt={t("ride.rateRider")}
              onDone={() => setRateRide(null)}
            />
          </Card>
        ) : null}

        {job === undefined ? (
          <Skeleton className="h-40 w-full" />
        ) : job?.kind === "ride" ? (
          <ActiveRidePanel job={job} position={hb.position} onChanged={loadJob} />
        ) : job?.kind === "delivery" ? (
          <ActiveDeliveryPanel job={job} onChanged={loadJob} />
        ) : offer ? (
          <OfferCard key={offer.offer_id} offer={offer} busy={responding} onRespond={respond} onExpired={onExpired} />
        ) : approved ? (
          <EmptyState
            icon={RadioTower}
            title={hb.online ? t("waiting") : t("goOnline")}
            description={hb.online ? t("waitingHint") : undefined}
          />
        ) : null}

        {me?.courier ? (
          <Card padding="none" className="divide-y divide-subtle">
            <ListItem href="/courier/earnings" icon={Wallet} title={t("earnings")} subtitle={t("earningsHint")} />
            <ListItem href="/courier/code" icon={QrCode} title={t("myCode")} />
          </Card>
        ) : null}
      </div>
    </div>
  );
}
