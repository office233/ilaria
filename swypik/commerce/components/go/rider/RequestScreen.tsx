"use client";

/**
 * /go — comanda unei curse: hartă, pickup/destinație (geocoding intern),
 * clasele disponibile cu tarif estimat (/api/rides/quote), plata permisă,
 * comandă → /go/[id] (unde cardul e autorizat înainte de dispatch).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { History } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { IconButton } from "@/components/ui/IconButton";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import RideMap from "../RideMap";
import { goErrorKey, goFetch, useGoFormat } from "../format";
import type { Place } from "../types";
import { useLocatePickup, useQuote } from "./hooks";
import RoutePanel from "./RoutePanel";
import ClassPicker from "./ClassPicker";
import PaymentPicker from "./PaymentPicker";

function deepLinkDropoff(params: URLSearchParams): Place | null {
  const address = params.get("dropoff");
  const lat = Number.parseFloat(params.get("dlat") ?? "");
  const lng = Number.parseFloat(params.get("dlng") ?? "");
  return address && Number.isFinite(lat) && Number.isFinite(lng) ? { address, lat, lng } : null;
}

export default function RequestScreen() {
  const t = useTranslations("go");
  const router = useRouter();
  const params = useSearchParams();
  const { toast } = useToast();
  const f = useGoFormat();
  const [pickup, setPickup] = useState<Place | null>(null);
  const [dropoff, setDropoff] = useState<Place | null>(() => deepLinkDropoff(params));
  const [vehicleClass, setVehicleClass] = useState<string | null>(null);
  const [method, setMethod] = useState<"card" | "cash" | null>(null);
  const [ordering, setOrdering] = useState(false);
  const { quote, loading, error } = useQuote(pickup, dropoff);
  const locate = useLocatePickup(t("myLocation"), setPickup);

  useEffect(() => {
    locate();
  }, [locate]);

  // Clasa / metoda aleasă trebuie să existe în oferta curentă.
  useEffect(() => {
    if (!quote) return;
    setVehicleClass((c) => (c && quote.classes.some((q) => q.vehicle_class === c) ? c : quote.classes[0]?.vehicle_class ?? null));
    setMethod((m) => (m && quote.payment_methods.includes(m) ? m : quote.payment_methods[0] ?? null));
  }, [quote]);

  const selected = quote?.classes.find((c) => c.vehicle_class === vehicleClass) ?? null;

  const order = useCallback(async () => {
    if (!pickup || !dropoff || !vehicleClass || !method || ordering) return;
    setOrdering(true);
    const r = await goFetch<{ ride_id: string }>("/api/rides", {
      method: "POST",
      body: JSON.stringify({ pickup, dropoff, vehicle_class: vehicleClass, payment_method: method }),
    });
    if (r.ok) {
      router.push(`/go/${r.data.ride_id}`);
      return;
    }
    setOrdering(false);
    if (r.status === 401) {
      router.push(`/auth/login?next=${encodeURIComponent("/go")}`);
      return;
    }
    if (r.error === "active_ride") {
      const again = await goFetch<{ rides: { id: string; status: string }[] }>("/api/rides?limit=1");
      const active = again.ok ? again.data.rides.find((x) => !["completed", "cancelled"].includes(x.status)) : null;
      if (active) {
        router.push(`/go/${active.id}`);
        return;
      }
    }
    toast({ title: t(goErrorKey(r.error)), tone: "danger" });
  }, [pickup, dropoff, vehicleClass, method, ordering, router, toast, t]);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <PageHeader
        title={t("title")}
        actions={
          <IconButton label={t("rideHistory")} asChild>
            <Link href="/go/history">
              <History aria-hidden />
            </Link>
          </IconButton>
        }
      />
      <div className="relative h-[38dvh] min-h-[220px] w-full overflow-hidden">
        <RideMap
          pickup={pickup ? { ...pickup, label: pickup.address } : null}
          dropoff={dropoff ? { ...dropoff, label: dropoff.address } : null}
          onLocate={locate}
        />
      </div>
      <div className="relative z-10 -mt-4 flex flex-1 flex-col gap-4 rounded-t-sheet bg-canvas px-gutter pb-4 pt-4 shadow-elev-2">
        <RoutePanel pickup={pickup} dropoff={dropoff} onPickup={setPickup} onDropoff={setDropoff} onLocate={locate} />

        {!pickup || !dropoff ? (
          <p className="text-center text-sm text-muted">{t("selectDestinationHint")}</p>
        ) : loading && !quote ? (
          <div className="space-y-2" aria-busy>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : error ? (
          <EmptyState title={t(goErrorKey(error))} description={error === "no_zone" ? t("noZoneHint") : undefined} />
        ) : quote ? (
          <>
            <ClassPicker classes={quote.classes} selected={vehicleClass} onSelect={setVehicleClass} />
            <PaymentPicker methods={quote.payment_methods} value={method} onChange={setMethod} />
            <p className="text-xs text-muted">
              {t("policyNote", {
                grace: Math.round(quote.free_cancel_grace_seconds / 60),
                cap: Math.round(quote.fare_overrun_cap_bps / 100),
              })}
            </p>
          </>
        ) : null}

        <div className="sticky bottom-0 mt-auto bg-canvas pb-safe-b pt-2">
          <Button block size="lg" loading={ordering} disabled={!selected || !method} onClick={order}>
            {selected ? t("order", { price: f.money(selected.total_cents, selected.currency) }) : t("orderNoPrice")}
          </Button>
        </div>
      </div>
    </div>
  );
}
