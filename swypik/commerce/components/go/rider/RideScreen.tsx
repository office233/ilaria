"use client";

/**
 * /go/[id] — cursa live: autorizare card (înainte de dispatch), căutare,
 * șofer + poziție live (SSE, polling fallback), anulare cu taxa calculată de
 * server, bon + rating. Starea vine mereu de la server (reload-safe).
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/ErrorState";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import RideMap from "../RideMap";
import { useRideLive } from "../useRideLive";
import { goErrorKey, goFetch, useGoFormat } from "../format";
import CardAuthorizePanel from "./CardAuthorizePanel";
import DriverCard from "./DriverCard";
import CancelSheet, { type CancelReason } from "./CancelSheet";
import { CancelledPanel, ReceiptPanel, SearchingPanel } from "./RidePanels";
import { APP_URL } from "@/lib/app-url";

const KNOWN_STATUS = new Set(["requested", "searching", "accepted", "arriving", "in_progress", "completed", "cancelled"]);

export default function RideScreen({ rideId }: { rideId: string }) {
  const t = useTranslations("go");
  const f = useGoFormat();
  const { toast } = useToast();
  const { data, driverPos, error, refresh } = useRideLive(rideId);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [rated, setRated] = useState(false);

  if (error && !data) {
    return (
      <div className="min-h-dvh bg-canvas">
        <PageHeader back="/go" title={t("title")} />
        <ErrorState description={t(goErrorKey(error))} onRetry={() => void refresh()} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="min-h-dvh bg-canvas" aria-busy>
        <PageHeader back="/go" title={t("title")} />
        <Skeleton className="h-[40dvh] w-full rounded-none" />
        <div className="space-y-3 p-gutter">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  const { ride, driver, cancel_policy: policy } = data;
  const awaitingPayment = ride.status === "requested" && ride.payment_method === "card" && ride.payment_status === "unpaid";
  const searching = !awaitingPayment && (ride.status === "requested" || ride.status === "searching");
  const active = ["accepted", "arriving", "in_progress"].includes(ride.status);
  // Grația expiră în timp ce ecranul e deschis: momentul vine de la server.
  const feeNow =
    policy.free_until && Date.now() > Date.parse(policy.free_until) ? policy.zone_fee_cents : policy.fee_cents_now;
  const alreadyRated = rated || data.ratings.some((r) => r.rater_role === "rider");

  const doCancel = async (reason: CancelReason, other: string) => {
    setCancelling(true);
    const r = await goFetch(`/api/rides/${rideId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "cancelled", cancel_reason: reason, reason: reason === "other" ? other.trim() || undefined : undefined }),
    });
    setCancelling(false);
    if (!r.ok) {
      toast({ title: t(goErrorKey(r.error)), tone: "danger" });
      return;
    }
    setCancelOpen(false);
    void refresh();
  };

  const share = ride.share_token
    ? async () => {
        // APP_URL, nu window.location.origin (capacitor://localhost în aplicația nativă).
        const url = `${APP_URL}/go/track/${ride.share_token}`;
        try {
          if (navigator.share) await navigator.share({ title: t("track.title"), url });
          else {
            await navigator.clipboard.writeText(url);
            toast({ title: t("share.copied"), tone: "success" });
          }
        } catch {
          /* share sheet închis */
        }
      }
    : null;

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <PageHeader back="/go" title={KNOWN_STATUS.has(ride.status) ? t(`status.${ride.status}`) : t("title")} />
      <div className="relative h-[40dvh] min-h-[220px] w-full overflow-hidden">
        <RideMap
          pickup={{ lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng), label: ride.pickup_address }}
          dropoff={{ lat: Number(ride.dropoff_lat), lng: Number(ride.dropoff_lng), label: ride.dropoff_address }}
          driver={active && driverPos ? { ...driverPos, label: driver?.full_name } : null}
        />
      </div>
      <div className="relative z-10 -mt-4 flex flex-1 flex-col gap-4 rounded-t-sheet bg-canvas px-gutter pb-safe-b pt-4 shadow-elev-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 text-sm">
            <p className="truncate text-fg">{ride.pickup_address}</p>
            <p className="truncate text-muted">→ {ride.dropoff_address}</p>
          </div>
          <Badge tone="neutral">{f.money(ride.final_fare_cents ?? ride.estimated_fare_cents, ride.currency)}</Badge>
        </div>

        {awaitingPayment ? (
          <>
            <CardAuthorizePanel rideId={rideId} currency={ride.currency} onAuthorized={() => void refresh()} />
            <Button variant="ghost" block onClick={() => setCancelOpen(true)}>
              {t("cancel.confirm")}
            </Button>
          </>
        ) : null}
        {searching ? <SearchingPanel requestedAt={ride.requested_at} onCancel={() => setCancelOpen(true)} /> : null}
        {active && driver ? <DriverCard driver={driver} onShare={share} /> : null}
        {active && ride.status !== "in_progress" ? (
          <Button variant="secondary" block onClick={() => setCancelOpen(true)}>
            {t("cancel.confirm")}
          </Button>
        ) : null}
        {ride.status === "completed" ? <ReceiptPanel ride={ride} rated={alreadyRated} onRated={() => setRated(true)} /> : null}
        {ride.status === "cancelled" ? <CancelledPanel ride={ride} /> : null}
      </div>
      <CancelSheet
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        feeCents={feeNow}
        currency={ride.currency}
        busy={cancelling}
        onConfirm={doCancel}
      />
    </div>
  );
}
