"use client";

/**
 * /go/track/[token] — pagină PUBLICĂ de urmărire cursă (share trip).
 * Hartă live (poll 10s), fără date sensibile: doar prenumele șoferului,
 * pickup/dropoff și poziția live. Link-ul expiră la finalul cursei + 1h.
 */
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";

const MapView = dynamic(() => import("@/components/map/MapView"), { ssr: false });
const LiveMarker = dynamic(() => import("@/components/map/LiveMarker"), { ssr: false });
const RoutePolyline = dynamic(() => import("@/components/map/RoutePolyline"), { ssr: false });

type Snapshot = {
  status: string;
  pickup: { address: string; lat: number; lng: number };
  dropoff: { address: string; lat: number; lng: number };
  driver: { first_name: string; position: { lat: number; lng: number } | null } | null;
};

export default function TrackClient({ token }: { token: string }) {
  const t = useTranslations("go.track");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/go/track/${token}`, { cache: "no-store" });
        if (!res.ok) {
          if (!stop) setError(true);
          return;
        }
        const data: Snapshot = await res.json();
        if (!stop) setSnap(data);
      } catch {
        /* retry la următorul tick */
      }
    };
    void load();
    const iv = setInterval(load, 10_000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [token]);

  if (error) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <p className="text-center text-[15px] font-semibold text-neutral-600">{t("expired")}</p>
      </main>
    );
  }
  if (!snap) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <p className="text-center text-[14px] text-neutral-500">{t("loading")}</p>
      </main>
    );
  }

  const done = snap.status === "completed" || snap.status === "cancelled";
  return (
    <main className="relative min-h-dvh">
      <div className="h-[60dvh] w-full">
        <MapView
          center={snap.driver?.position ?? snap.pickup}
          fitBounds={[snap.pickup, snap.dropoff, ...(snap.driver?.position ? [snap.driver.position] : [])]}
        >
          <LiveMarker position={snap.pickup} kind="pickup" label={snap.pickup.address} />
          <LiveMarker position={snap.dropoff} kind="dropoff" label={snap.dropoff.address} />
          {snap.driver?.position ? (
            <LiveMarker position={snap.driver.position} kind="driver" label={snap.driver.first_name} />
          ) : null}
          <RoutePolyline points={[snap.pickup, snap.dropoff]} />
        </MapView>
      </div>
      <div className="rounded-t-3xl bg-white p-5 shadow-[0_-8px_30px_rgba(0,0,0,.08)]">
        <h1 className="text-[17px] font-extrabold">{t("title")}</h1>
        <p className="mt-1 text-[13px] text-neutral-500">
          {done ? t("finished") : snap.driver ? t("withDriver", { name: snap.driver.first_name }) : t("searching")}
        </p>
        <div className="mt-3 space-y-1 text-[13px]">
          <p className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-green-500" /> {snap.pickup.address}</p>
          <p className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red-500" /> {snap.dropoff.address}</p>
        </div>
      </div>
    </main>
  );
}
