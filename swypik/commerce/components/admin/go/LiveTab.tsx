"use client";

/** Dispatch live: hartă (șoferi online + pickup-uri), curse active, taxe datorate. */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import RideMap from "@/components/go/RideMap";
import { goErrorKey, goFetch, useGoFormat } from "@/components/go/format";
import type { LiveRide, OnlineDriver, OwedFee } from "@/lib/rides/admin-ops";
import { ADMIN_POLL_MS, useAdminResource } from "./useAdminApi";
import RideActionsSheet from "./RideActionsSheet";

type Overview = {
  drivers: OnlineDriver[];
  rides: LiveRide[];
  owed_fees: OwedFee[];
  stats: { completed_today: number; cancelled_today: number; fees_owed: number; unpaid_issues: number };
};

export default function LiveTab() {
  const t = useTranslations("adminGo");
  const tGo = useTranslations("go");
  const f = useGoFormat();
  const { toast } = useToast();
  const { data, error, reload } = useAdminResource<Overview>("/api/admin/go/overview", ADMIN_POLL_MS);
  const [selected, setSelected] = useState<LiveRide | null>(null);

  if (error && !data) return <ErrorState description={t("loadError")} onRetry={() => void reload()} />;
  if (!data) return <Skeleton className="h-96 w-full" />;

  const markers = [
    ...data.drivers
      .filter((d) => d.current_lat != null && d.current_lng != null)
      .map((d) => ({ id: `d-${d.id}`, lat: Number(d.current_lat), lng: Number(d.current_lng), label: d.full_name })),
    ...data.rides.map((r) => ({ id: `r-${r.id}`, lat: Number(r.pickup_lat), lng: Number(r.pickup_lng), label: r.pickup_address })),
  ];

  const waive = async (id: string) => {
    const r = await goFetch(`/api/admin/go/rides/${id}`, { method: "POST", body: JSON.stringify({ action: "waive_fee" }) });
    toast({ title: r.ok ? t("done") : tGo(goErrorKey(r.error)), tone: r.ok ? "success" : "danger" });
    void reload();
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          [t("stats.online"), data.drivers.length],
          [t("stats.active"), data.rides.length],
          [t("stats.completed"), data.stats.completed_today],
          [t("stats.cancelled"), data.stats.cancelled_today],
          [t("stats.unpaid"), data.stats.unpaid_issues],
        ].map(([label, value]) => (
          <Card key={String(label)} padding="sm">
            <p className="text-xs text-muted">{label}</p>
            <p className="text-xl font-semibold text-fg">{value}</p>
          </Card>
        ))}
      </div>

      <div className="relative h-[45dvh] min-h-[260px] overflow-hidden rounded-card border border-subtle">
        <RideMap extra={markers} />
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-fg">{t("activeRides")}</h2>
        {data.rides.length === 0 ? <EmptyState title={t("noActiveRides")} /> : null}
        {data.rides.map((r) => (
          <Card key={r.id} padding="sm" className="flex flex-wrap items-center gap-3">
            <Badge tone={r.status === "searching" || r.status === "requested" ? "warning" : "info"}>{tGo(`status.${r.status}`)}</Badge>
            <div className="min-w-0 flex-1 text-sm">
              <p className="truncate text-fg">
                {r.city} · {r.pickup_address} → {r.dropoff_address}
              </p>
              <p className="text-xs text-muted">
                {f.time(r.requested_at)} · {r.payment_method}/{r.payment_status} · {f.money(r.estimated_fare_cents, r.currency)} ·{" "}
                {r.driver_name ?? t("noDriver")}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setSelected(r)}>
              {t("actions")}
            </Button>
          </Card>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-fg">{t("onlineDrivers")}</h2>
        {data.drivers.length === 0 ? <EmptyState title={t("noDrivers")} /> : null}
        <div className="grid gap-2 sm:grid-cols-2">
          {data.drivers.map((d) => (
            <Card key={d.id} padding="sm" className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-fg">
                {d.full_name} · {d.city} {d.vehicle_plate ? `· ${d.vehicle_plate}` : ""}
              </span>
              <Badge tone={d.busy ? "warning" : "success"}>{d.busy ? t("busy") : t("free")}</Badge>
            </Card>
          ))}
        </div>
      </section>

      {data.owed_fees.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-fg">{t("owedFees")}</h2>
          {data.owed_fees.map((o) => (
            <Card key={o.id} padding="sm" className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-fg">
                {f.money(o.cancel_fee_cents, o.currency)} · {o.pickup_address} · {f.time(o.cancelled_at)}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void waive(o.id)}>
                {t("waive")}
              </Button>
            </Card>
          ))}
        </section>
      ) : null}

      <RideActionsSheet
        ride={selected}
        drivers={data.drivers}
        onClose={() => setSelected(null)}
        onDone={() => {
          setSelected(null);
          void reload();
        }}
      />
    </div>
  );
}
