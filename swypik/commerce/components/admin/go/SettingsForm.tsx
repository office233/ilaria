"use client";

/** Setările Go (cash/card, grație anulare, plafon tarif, TTL autorizare, documente) — PATCH auditat. */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { TextField } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { goFetch } from "@/components/go/format";
import { DRIVER_DOCUMENT_TYPES, type GoSettings } from "@/lib/rides/settings-shared";
import { useAdminResource } from "./useAdminApi";

export default function SettingsForm() {
  const t = useTranslations("adminGo");
  const tDocs = useTranslations("goDriver");
  const { toast } = useToast();
  const { data, reload } = useAdminResource<{ settings: GoSettings }>("/api/admin/go/settings");
  const [s, setS] = useState<GoSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setS(data?.settings ?? null), [data]);
  if (!s) return null;

  const num = (k: "free_cancel_grace_seconds" | "fare_overrun_cap_bps" | "payment_auth_ttl_minutes") => (e: { target: { value: string } }) =>
    setS({ ...s, [k]: Math.trunc(Number(e.target.value) || 0) });

  const save = async () => {
    setBusy(true);
    const r = await goFetch("/api/admin/go/settings", { method: "PATCH", body: JSON.stringify(s) });
    setBusy(false);
    toast({ title: r.ok ? t("saved") : t("saveError"), tone: r.ok ? "success" : "danger" });
    void reload();
  };

  return (
    <Card className="space-y-4">
      <h2 className="text-lg font-semibold text-fg">{t("settings.title")}</h2>
      {(["card_enabled", "cash_enabled"] as const).map((k) => (
        <label key={k} className="flex min-h-[44px] items-center justify-between gap-3 text-sm text-fg">
          {t(`settings.${k}`)}
          <Switch checked={s[k]} onCheckedChange={(v) => setS({ ...s, [k]: v })} />
        </label>
      ))}
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField label={t("settings.grace")} inputMode="numeric" value={String(s.free_cancel_grace_seconds)} onChange={num("free_cancel_grace_seconds")} />
        <TextField label={t("settings.cap")} inputMode="numeric" value={String(s.fare_overrun_cap_bps)} onChange={num("fare_overrun_cap_bps")} hint={t("settings.capHint")} />
        <TextField label={t("settings.ttl")} inputMode="numeric" value={String(s.payment_auth_ttl_minutes)} onChange={num("payment_auth_ttl_minutes")} />
      </div>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-fg">{t("settings.requiredDocs")}</legend>
        {DRIVER_DOCUMENT_TYPES.map((d) => (
          <label key={d} className="flex min-h-[44px] items-center gap-3 text-sm text-fg">
            <input
              type="checkbox"
              className="h-5 w-5 accent-current"
              checked={s.required_driver_documents.includes(d)}
              onChange={(e) =>
                setS({
                  ...s,
                  required_driver_documents: e.target.checked
                    ? [...s.required_driver_documents, d]
                    : s.required_driver_documents.filter((x) => x !== d),
                })
              }
            />
            {tDocs(`docs.${d}`)}
          </label>
        ))}
      </fieldset>
      <Button loading={busy} onClick={() => void save()}>
        {t("save")}
      </Button>
    </Card>
  );
}
