"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Field, TextField } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { CARRIER_CODES, type CarrierCode } from "@/lib/fulfillment/carriers";

export type ShipInput = { courier: CarrierCode; manual_tracking_number: string; locker_name?: string };

/** Expediere: curier + AWB-ul primit de la curier (Swypik nu generează AWB-uri). */
export function ShipForm({ busy, onSubmit, onCancel }: { busy: boolean; onSubmit: (v: ShipInput) => void; onCancel: () => void }) {
  const t = useTranslations("sellerPanel.orders.ship");
  const [courier, setCourier] = useState<CarrierCode>("sameday");
  const [awb, setAwb] = useState("");
  const [locker, setLocker] = useState("");
  const valid = awb.trim().length >= 3;

  return (
    <form
      className="space-y-3 rounded-card bg-surface-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSubmit({ courier, manual_tracking_number: awb.trim(), ...(locker.trim() ? { locker_name: locker.trim() } : {}) });
      }}
    >
      <Field label={t("carrier")}>
        {(f) => (
          <Select
            {...f}
            value={courier}
            onChange={(e) => setCourier(e.target.value as CarrierCode)}
            options={CARRIER_CODES.map((c) => ({ value: c, label: t(`carriers.${c}`) }))}
          />
        )}
      </Field>
      <TextField label={t("awb")} hint={t("awbHint")} value={awb} onChange={(e) => setAwb(e.target.value)} required autoComplete="off" />
      {courier === "sameday_easybox" ? (
        <TextField label={t("locker")} value={locker} onChange={(e) => setLocker(e.target.value)} />
      ) : null}
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" className="flex-1" loading={busy} disabled={!valid}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}
