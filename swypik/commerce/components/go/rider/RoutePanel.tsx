"use client";

import { ArrowUpDown, LocateFixed } from "lucide-react";
import { useTranslations } from "next-intl";
import AddressAutocomplete from "@/components/map/AddressAutocomplete";
import { IconButton } from "@/components/ui/IconButton";
import type { Place } from "../types";

type Props = {
  pickup: Place | null;
  dropoff: Place | null;
  onPickup: (p: Place | null) => void;
  onDropoff: (p: Place | null) => void;
  onLocate: () => void;
};

/** Pickup + destinație (căutare prin geocoding-ul intern), inversare, locația mea. */
export default function RoutePanel({ pickup, dropoff, onPickup, onDropoff, onLocate }: Props) {
  const t = useTranslations("go");
  return (
    <div className="relative space-y-2 rounded-card border border-subtle bg-surface p-2">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <AddressAutocomplete
            key={`p-${pickup?.lat ?? ""}-${pickup?.lng ?? ""}`}
            placeholder={t("pickupPlaceholder")}
            value={pickup?.address}
            onSelect={(r) => onPickup({ address: r.address, lat: r.lat, lng: r.lng })}
            onClear={() => onPickup(null)}
            clearLabel={t("clearAddress")}
            icon={<span aria-hidden className="block h-2.5 w-2.5 shrink-0 rounded-full bg-success" />}
          />
        </div>
        <IconButton label={t("myLocation")} onClick={onLocate}>
          <LocateFixed aria-hidden />
        </IconButton>
      </div>
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <AddressAutocomplete
            key={`d-${dropoff?.lat ?? ""}-${dropoff?.lng ?? ""}`}
            placeholder={t("dropoffPlaceholder")}
            value={dropoff?.address}
            onSelect={(r) => onDropoff({ address: r.address, lat: r.lat, lng: r.lng })}
            onClear={() => onDropoff(null)}
            clearLabel={t("clearAddress")}
            icon={<span aria-hidden className="block h-2.5 w-2.5 shrink-0 rounded-full bg-danger" />}
          />
        </div>
        <IconButton
          label={t("swapAddresses")}
          disabled={!pickup || !dropoff}
          onClick={() => {
            onPickup(dropoff);
            onDropoff(pickup);
          }}
        >
          <ArrowUpDown aria-hidden />
        </IconButton>
      </div>
    </div>
  );
}
