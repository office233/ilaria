"use client";

/**
 * Editor zonă tarifară — trimite la /api/admin/pricing (upsert_zone /
 * update_zone, auditate cu valorile noi). Sumele se introduc în unități
 * (ex. lei), se trimit în cenți.
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Input";
import { Field } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { goFetch } from "@/components/go/format";

export type Zone = {
  id: string;
  city: string;
  country: string;
  kind: string;
  vehicle_class: string;
  base_cents: number;
  per_km_cents: number;
  per_min_cents: number;
  min_fare_cents: number;
  booking_fee_cents: number;
  cancel_fee_cents: number;
  platform_commission_pct: string;
  courier_share_pct: string;
  currency: string;
  max_passengers: number | null;
  active: boolean;
};

const MONEY = ["base_cents", "per_km_cents", "per_min_cents", "min_fare_cents", "booking_fee_cents", "cancel_fee_cents"] as const;
const PCT = ["platform_commission_pct", "courier_share_pct"] as const;
const KINDS = ["ride", "delivery", "errand"];
const CLASSES = ["economy", "comfort", "van", "bike"];

type Form = Record<string, string>;

function toForm(z: Zone | null): Form {
  const out: Form = {
    city: z?.city ?? "",
    country: z?.country ?? "RO",
    kind: z?.kind ?? "ride",
    vehicle_class: z?.vehicle_class ?? "economy",
    currency: z?.currency?.trim() ?? "RON",
    max_passengers: z?.max_passengers != null ? String(z.max_passengers) : "",
  };
  for (const k of MONEY) out[k] = z ? String(z[k] / 100) : "";
  for (const k of PCT) out[k] = z ? String(Number(z[k])) : "";
  return out;
}

export default function ZoneEditor({ zone, open, onClose, onSaved }: { zone: Zone | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("adminGo");
  const { toast } = useToast();
  const [form, setForm] = useState<Form>(() => toForm(zone));
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(toForm(zone)), [zone, open]);

  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    const values: Record<string, number | string | null> = {};
    for (const k of MONEY) values[k] = Math.round(Number(form[k]) * 100);
    for (const k of PCT) values[k] = Number(form[k]);
    values.max_passengers = form.max_passengers ? Number(form.max_passengers) : null;
    if (Object.values(values).some((v) => typeof v === "number" && !Number.isFinite(v))) {
      toast({ title: t("invalidNumbers"), tone: "danger" });
      return;
    }
    const body = zone
      ? { action: "update_zone", id: zone.id, patch: values }
      : { action: "upsert_zone", ...values, city: form.city, country: form.country, kind: form.kind, vehicle_class: form.vehicle_class, currency: form.currency };
    setBusy(true);
    const r = await goFetch("/api/admin/pricing", { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    toast({ title: r.ok ? t("saved") : t("saveError"), tone: r.ok ? "success" : "danger" });
    if (r.ok) onSaved();
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={zone ? `${zone.city} · ${zone.kind} · ${zone.vehicle_class}` : t("newZone")}
      footer={
        <Button block loading={busy} onClick={() => void save()}>
          {t("save")}
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        {!zone ? (
          <>
            <TextField label={t("zone.city")} value={form.city} onChange={set("city")} className="col-span-2" />
            <Field label={t("zone.kind")}>
              {(fp) => <Select {...fp} value={form.kind} onChange={set("kind")} options={KINDS.map((k) => ({ value: k, label: k }))} />}
            </Field>
            <Field label={t("zone.class")}>
              {(fp) => <Select {...fp} value={form.vehicle_class} onChange={set("vehicle_class")} options={CLASSES.map((k) => ({ value: k, label: k }))} />}
            </Field>
            <TextField label={t("zone.country")} value={form.country} maxLength={2} onChange={set("country")} />
            <TextField label={t("zone.currency")} value={form.currency} maxLength={3} onChange={set("currency")} />
          </>
        ) : null}
        {MONEY.map((k) => (
          <TextField key={k} label={t(`zone.${k}`)} inputMode="decimal" value={form[k]} onChange={set(k)} />
        ))}
        {PCT.map((k) => (
          <TextField key={k} label={t(`zone.${k}`)} inputMode="decimal" value={form[k]} onChange={set(k)} />
        ))}
        <TextField label={t("zone.max_passengers")} inputMode="numeric" value={form.max_passengers} onChange={set("max_passengers")} />
      </div>
    </Sheet>
  );
}
