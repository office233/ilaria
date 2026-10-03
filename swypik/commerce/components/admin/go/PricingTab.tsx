"use client";

/** Tarife pe zone (editabile, auditate) + setările Go. Surge-ul manual rămâne în /admin/pricing. */
import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/ErrorState";
import { useToast } from "@/components/ui/Toast";
import { goFetch, useGoFormat } from "@/components/go/format";
import { useAdminResource } from "./useAdminApi";
import ZoneEditor, { type Zone } from "./ZoneEditor";
import SettingsForm from "./SettingsForm";

export default function PricingTab() {
  const t = useTranslations("adminGo");
  const f = useGoFormat();
  const { toast } = useToast();
  const { data, error, reload } = useAdminResource<{ zones: Zone[] }>("/api/admin/pricing");
  const [editing, setEditing] = useState<Zone | null>(null);
  const [creating, setCreating] = useState(false);

  const toggle = async (z: Zone) => {
    const r = await goFetch("/api/admin/pricing", { method: "POST", body: JSON.stringify({ action: "toggle_zone", id: z.id, active: !z.active }) });
    toast({ title: r.ok ? t("saved") : t("saveError"), tone: r.ok ? "success" : "danger" });
    void reload();
  };

  return (
    <div className="space-y-6">
      <SettingsForm />
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-fg">{t("zones")}</h2>
          <div className="flex gap-2">
            <Button asChild size="sm" variant="ghost">
              <Link href="/admin/pricing">{t("surgeLink")}</Link>
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              {t("newZone")}
            </Button>
          </div>
        </div>
        {error ? <ErrorState description={t("loadError")} onRetry={() => void reload()} /> : null}
        {!data && !error ? <Skeleton className="h-40 w-full" /> : null}
        {data?.zones.map((z) => (
          <Card key={z.id} padding="sm" className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium text-fg">
                {z.city} · {z.kind} · {z.vehicle_class}{" "}
                <Badge tone={z.active ? "success" : "neutral"}>{z.active ? t("active") : t("inactive")}</Badge>
              </p>
              <p className="text-xs text-muted">
                {t("zoneSummary", {
                  base: f.money(z.base_cents, z.currency),
                  km: f.money(z.per_km_cents, z.currency),
                  min: f.money(z.per_min_cents, z.currency),
                  minFare: f.money(z.min_fare_cents, z.currency),
                  cancel: f.money(z.cancel_fee_cents, z.currency),
                  commission: Number(z.platform_commission_pct),
                })}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setEditing(z)}>
              {t("edit")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void toggle(z)}>
              {z.active ? t("deactivate") : t("activate")}
            </Button>
          </Card>
        ))}
      </section>
      <ZoneEditor
        zone={editing}
        open={Boolean(editing) || creating}
        onClose={() => {
          setEditing(null);
          setCreating(false);
        }}
        onSaved={() => {
          setEditing(null);
          setCreating(false);
          void reload();
        }}
      />
    </div>
  );
}
