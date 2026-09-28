"use client";

/** Datele de livrare: nume, telefon, adresă (salvate / căutare / pin pe hartă), observații. */
import dynamic from "next/dynamic";
import { MapPin } from "lucide-react";
import { useTranslations } from "next-intl";
import { TextField } from "@/components/ui/Input";
import AddressAutocomplete, { type AddressResult } from "@/components/map/AddressAutocomplete";
import { haptic } from "@/lib/haptic";
import type { useCheckout } from "./useCheckout";

const MapView = dynamic(() => import("@/components/map/MapView"), { ssr: false });
const LiveMarker = dynamic(() => import("@/components/map/LiveMarker"), { ssr: false });

type Fields = ReturnType<typeof useCheckout>["fields"];

export default function DeliveryFields({ f, outOfRange, needsLocation }: { f: Fields; outOfRange: boolean; needsLocation: boolean }) {
  const t = useTranslations("foodHub");

  return (
    <div className="space-y-3">
      <TextField label={t("nameLabel")} value={f.name} onChange={(e) => f.setName(e.target.value)} autoComplete="name" maxLength={120} required />
      <TextField label={t("phoneLabel")} value={f.phone} onChange={(e) => f.setPhone(e.target.value)} type="tel" inputMode="tel" autoComplete="tel" maxLength={32} required />

      {f.saved.length > 0 ? (
        <div className="-mx-gutter flex gap-2 overflow-x-auto px-gutter pb-1 scrollbar-none">
          {f.saved.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                haptic("tap");
                f.applySaved(a);
              }}
              className="inline-flex h-11 shrink-0 items-center gap-1 rounded-full border border-subtle px-4 text-sm font-semibold text-fg"
            >
              <MapPin size={14} aria-hidden /> {a.label || a.line1.slice(0, 24)}
            </button>
          ))}
        </div>
      ) : null}

      <div>
        <p className="mb-1.5 text-sm font-medium text-fg">{t("addressLabel")}</p>
        <AddressAutocomplete
          placeholder={t("addressPlaceholder")}
          value={f.address}
          clearLabel={t("clearAddress")}
          onSelect={(r: AddressResult) => {
            f.setAddress(r.address);
            f.setCoords({ lat: r.lat, lng: r.lng });
          }}
          onClear={() => {
            f.setAddress("");
            f.setCoords(null);
          }}
        />
        {needsLocation ? <p className="mt-1.5 text-sm font-semibold text-warning">{t("errors.delivery_location_required")}</p> : null}
      </div>

      {f.coords ? (
        <div className="overflow-hidden rounded-card border border-subtle">
          <MapView
            center={f.coords}
            zoom={16}
            className="h-44 w-full"
            flyTo={f.coords}
            onMapClick={(p) => {
              haptic("tap");
              f.setCoords(p);
            }}
          >
            <LiveMarker position={f.coords} kind="dropoff" label={t("deliverHere")} />
          </MapView>
          <p className="flex items-center gap-1 bg-surface-2 px-3 py-2 text-xs text-muted">
            <MapPin size={12} aria-hidden /> {t("adjustPin")}
          </p>
        </div>
      ) : null}

      {outOfRange ? <p className="rounded-control bg-danger-soft px-3 py-2 text-sm font-semibold text-danger">{t("errors.out_of_range")}</p> : null}

      <TextField label={t("notesLabel")} value={f.notes} onChange={(e) => f.setNotes(e.target.value)} placeholder={t("notesPlaceholder")} maxLength={500} />
    </div>
  );
}
