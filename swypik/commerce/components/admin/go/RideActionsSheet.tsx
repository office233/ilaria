"use client";

/** Acțiuni de dispecerat pe o cursă: atribuire/reatribuire, anulare forțată. */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { goErrorKey, goFetch } from "@/components/go/format";
import type { LiveRide, OnlineDriver } from "@/lib/rides/admin-ops";

type Props = { ride: LiveRide | null; drivers: OnlineDriver[]; onClose: () => void; onDone: () => void };

export default function RideActionsSheet({ ride, drivers, onClose, onDone }: Props) {
  const t = useTranslations("adminGo");
  const tGo = useTranslations("go");
  const { toast } = useToast();
  const [courierId, setCourierId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"assign" | "cancel" | null>(null);

  const candidates = ride
    ? drivers.filter((d) => d.kind === "driver" && !d.busy && d.id !== ride.driver_id && d.city.localeCompare(ride.city, undefined, { sensitivity: "base" }) === 0)
    : [];

  const run = async (action: "assign" | "cancel") => {
    if (!ride) return;
    setBusy(action);
    const body = action === "assign" ? { action, courier_id: courierId } : { action, reason: reason.trim() || undefined };
    const r = await goFetch(`/api/admin/go/rides/${ride.id}`, { method: "POST", body: JSON.stringify(body) });
    setBusy(null);
    toast({ title: r.ok ? t("done") : tGo(goErrorKey(r.error)), tone: r.ok ? "success" : "danger" });
    if (r.ok) {
      setCourierId("");
      setReason("");
      onDone();
    }
  };

  return (
    <Sheet open={Boolean(ride)} onOpenChange={(o) => !o && onClose()} title={t("rideActions")}>
      {ride ? (
        <div className="space-y-5">
          <p className="text-sm text-muted">
            {ride.pickup_address} → {ride.dropoff_address}
          </p>
          <div className="space-y-2">
            <Field label={ride.driver_id ? t("reassignTo") : t("assignTo")}>
              {(fp) => (
                <Select
                  {...fp}
                  value={courierId}
                  onChange={(e) => setCourierId(e.target.value)}
                  placeholder={candidates.length ? t("chooseDriver") : t("noFreeDrivers")}
                  options={candidates.map((d) => ({ value: d.id, label: `${d.full_name}${d.vehicle_plate ? ` · ${d.vehicle_plate}` : ""}` }))}
                />
              )}
            </Field>
            <Button block loading={busy === "assign"} disabled={!courierId} onClick={() => void run("assign")}>
              {ride.driver_id ? t("reassign") : t("assign")}
            </Button>
          </div>
          <div className="space-y-2 border-t border-subtle pt-4">
            <Field label={t("cancelReason")}>
              {(fp) => <Input {...fp} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
            </Field>
            <Button block variant="danger" loading={busy === "cancel"} onClick={() => void run("cancel")}>
              {t("forceCancel")}
            </Button>
            <p className="text-xs text-muted">{t("forceCancelHint")}</p>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
