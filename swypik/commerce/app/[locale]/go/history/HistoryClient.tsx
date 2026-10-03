"use client";

/** /go/history — cursele pasagerului, cu bon detaliat (expand pe tap). */
import { useCallback, useEffect, useState } from "react";
import { Link } from "@/lib/i18n/navigation";
import { History } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { goFetch, useGoFormat } from "@/components/go/format";

type RideRow = {
  id: string;
  status: string;
  vehicle_class: string;
  pickup_address: string;
  dropoff_address: string;
  estimated_fare_cents: number | null;
  final_fare_cents: number | null;
  currency: string;
  cancel_fee_cents: number | null;
  distance_km: string | null;
  duration_min: number | null;
  requested_at: string;
  driver_name: string | null;
  driver_rating: string | null;
};

const TONE: Record<string, "success" | "danger" | "info"> = { completed: "success", cancelled: "danger" };
const KNOWN_CLASS = new Set(["economy", "comfort", "van"]);

export default function HistoryClient() {
  const t = useTranslations("goHistory");
  const tGo = useTranslations("go");
  const f = useGoFormat();
  const [rides, setRides] = useState<RideRow[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(false);
    const r = await goFetch<{ rides: RideRow[] }>("/api/rides?limit=50");
    if (r.ok) setRides(r.data.rides);
    else setError(true);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-fg">{value}</dd>
    </div>
  );

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader
        back="/go"
        title={t("title")}
        actions={
          <Button asChild size="sm">
            <Link href="/go">{t("newRide")}</Link>
          </Button>
        }
      />
      <div className="mx-auto max-w-lg space-y-2 px-gutter py-4">
        {error ? <ErrorState description={t("error")} onRetry={() => void load()} /> : null}
        {!rides && !error ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />) : null}
        {rides?.length === 0 ? <EmptyState icon={History} title={t("empty")} /> : null}
        {rides?.map((r) => {
          const expanded = open === r.id;
          const total = r.status === "cancelled" ? r.cancel_fee_cents ?? 0 : r.final_fare_cents ?? r.estimated_fare_cents;
          return (
            <Card key={r.id} padding="none">
              <button type="button" className="min-h-[56px] w-full p-3 text-left" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-fg">
                    {r.pickup_address.split(",")[0]} → {r.dropoff_address.split(",")[0]}
                  </span>
                  <Badge tone={TONE[r.status] ?? "info"}>{tGo(`status.${r.status}`)}</Badge>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-muted">
                  <span>{f.time(r.requested_at)}</span>
                  <span className="font-semibold text-fg">{f.money(total, r.currency)}</span>
                </div>
              </button>
              {expanded ? (
                <div className="space-y-2 border-t border-subtle p-3 text-sm">
                  <dl className="space-y-1">
                    {row(t("class"), KNOWN_CLASS.has(r.vehicle_class) ? tGo(`class.${r.vehicle_class}`) : r.vehicle_class)}
                    {row(t("from"), r.pickup_address)}
                    {row(t("to"), r.dropoff_address)}
                    {r.distance_km ? row(t("distance"), tGo("distanceKm", { km: f.km(r.distance_km) })) : null}
                    {r.duration_min ? row(t("duration"), tGo("durationMin", { min: r.duration_min })) : null}
                    {r.driver_name ? row(t("driver"), `${r.driver_name}${r.driver_rating ? ` (★ ${Number(r.driver_rating).toFixed(2)})` : ""}`) : null}
                    {row(t("total"), f.money(total, r.currency))}
                  </dl>
                  <Button asChild variant="secondary" block>
                    <Link href={`/go/${r.id}`}>{t("viewRide")}</Link>
                  </Button>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
