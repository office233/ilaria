"use client";

/**
 * Harta Swypik Go (rider, șofer, consolă): pickup, destinație, șofer live și
 * markeri suplimentari. Leaflet se încarcă doar în browser.
 */
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { DEFAULT_MAP_CENTER } from "@/lib/config/geo";

const MapView = dynamic(() => import("@/components/map/MapView"), { ssr: false });
const LiveMarker = dynamic(() => import("@/components/map/LiveMarker"), { ssr: false });
const RoutePolyline = dynamic(() => import("@/components/map/RoutePolyline"), { ssr: false });

export type LatLng = { lat: number; lng: number };

export type RideMapProps = {
  pickup?: (LatLng & { label?: string }) | null;
  dropoff?: (LatLng & { label?: string }) | null;
  driver?: (LatLng & { label?: string }) | null;
  extra?: (LatLng & { id: string; label?: string })[];
  onLocate?: () => void;
  className?: string;
};

export default function RideMap({ pickup, dropoff, driver, extra, onLocate, className }: RideMapProps) {
  const t = useTranslations("go");
  const center = pickup ?? driver ?? extra?.[0] ?? DEFAULT_MAP_CENTER;
  const bounds = [pickup, dropoff, driver].filter((p): p is LatLng => Boolean(p));
  return (
    <MapView
      center={center}
      fitBounds={bounds.length >= 2 ? bounds : null}
      flyTo={bounds.length === 1 ? bounds[0] : null}
      onLocate={onLocate}
      showControls={Boolean(onLocate)}
      initial3D={false}
      className={className ?? "absolute inset-0 z-0 h-full w-full"}
    >
      {pickup ? (
        <LiveMarker
          position={pickup}
          kind="pickup"
          label={pickup.label}
          boardHereText={t("map.boardHere")}
          pickupFallbackLabel={t("map.pickup")}
        />
      ) : null}
      {dropoff ? (
        <LiveMarker
          position={dropoff}
          kind="dropoff"
          label={dropoff.label}
          destinationText={t("map.destination")}
          dropoffFallbackLabel={t("map.destination")}
        />
      ) : null}
      {driver ? <LiveMarker position={driver} kind="driver" label={driver.label} /> : null}
      {extra?.map((m) => <LiveMarker key={m.id} position={m} kind="nearby" label={m.label} />)}
      {pickup && dropoff ? <RoutePolyline points={[pickup, dropoff]} /> : null}
    </MapView>
  );
}
