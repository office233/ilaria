"use client";

/** Harta live: restaurant, adresa clientului, poziția curierului + ETA după preluare. */
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { VEHICLE_SPEED_KMH } from "@/lib/dispatch/constants";
import type { TrackedOrder } from "./useOrderTracking";

const MapView = dynamic(() => import("@/components/map/MapView"), { ssr: false });
const LiveMarker = dynamic(() => import("@/components/map/LiveMarker"), { ssr: false });
const RoutePolyline = dynamic(() => import("@/components/map/RoutePolyline"), { ssr: false });

type LatLng = { lat: number; lng: number };
const HANDOFF_BUFFER_MIN = 2;

/** Distanța în linie dreaptă (client-side; lib/pricing/distance importă Redis). */
function haversineKm(a: LatLng, b: LatLng): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const s = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

/** Minute rămase: după preluare din poziția curierului, altfel estimated_delivery_at. */
export function etaMinutes(order: TrackedOrder, courierPos: LatLng | null, now = Date.now()): number | null {
  const dest = order.delivery_lat != null && order.delivery_lng != null ? { lat: order.delivery_lat, lng: order.delivery_lng } : null;
  if (courierPos && dest && ["picked_up", "delivering"].includes(order.status)) {
    const speed = VEHICLE_SPEED_KMH[order.courier?.vehicle_type ?? "bike"] ?? VEHICLE_SPEED_KMH.bike ?? 20;
    return Math.max(HANDOFF_BUFFER_MIN, Math.round((haversineKm(courierPos, dest) / speed) * 60) + HANDOFF_BUFFER_MIN);
  }
  if (order.estimated_delivery_at) {
    const diff = Math.round((new Date(order.estimated_delivery_at).getTime() - now) / 60_000);
    return diff > 0 ? diff : null;
  }
  return null;
}

export default function TrackingMap({ order, courierPos }: { order: TrackedOrder; courierPos: LatLng | null }) {
  const t = useTranslations("food.tracking");
  const points: LatLng[] = [];
  const shop = order.merchant.lat != null && order.merchant.lng != null ? { lat: order.merchant.lat, lng: order.merchant.lng } : null;
  const dest = order.delivery_lat != null && order.delivery_lng != null ? { lat: order.delivery_lat, lng: order.delivery_lng } : null;
  if (shop) points.push(shop);
  if (courierPos) points.push(courierPos);
  if (dest) points.push(dest);
  const center = courierPos ?? points[0];
  if (!center) return null;

  return (
    <div className="relative h-64 w-full">
      <MapView center={center} fitBounds={points.length >= 2 ? points : null} className="h-full w-full">
        {shop ? <LiveMarker position={shop} kind="pickup" label={order.merchant.name} /> : null}
        {dest ? <LiveMarker position={dest} kind="dropoff" label={t("yourAddress")} /> : null}
        {courierPos ? <LiveMarker position={courierPos} kind="driver" label={order.courier?.name ?? t("courierFallback")} /> : null}
        {courierPos && dest ? <RoutePolyline points={[courierPos, dest]} /> : null}
      </MapView>
    </div>
  );
}
