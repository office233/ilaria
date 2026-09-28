"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

type Props = {
  zone?: { id: string; active: boolean };
  surge?: { id: string };
  addSurgeZones?: Array<{ id: string; label: string }>;
};

async function post(body: unknown): Promise<boolean> {
  const res = await fetch("/api/admin/pricing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}

export default function PricingActions({ zone, surge, addSurgeZones }: Props) {
    const t = useTranslations("adminPricing");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [zoneId, setZoneId] = useState("");
  const [multiplier, setMultiplier] = useState("1.2");
  const [minutes, setMinutes] = useState("60");
  const [err, setErr] = useState<string | null>(null);

  function run(body: unknown) {
    setErr(null);
    startTransition(async () => {
      const ok = await post(body);
      if (!ok) setErr(t("errGeneric"));
      router.refresh();
    });
  }

  if (zone) {
    return (
      <button
        disabled={pending}
        onClick={() => run({ action: "toggle_zone", id: zone.id, active: !zone.active })}
        className="rounded border px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        {zone.active ? t("deactivateBtn") : t("activateBtn")}
      </button>
    );
  }

  if (surge) {
    return (
      <button
        disabled={pending}
        onClick={() => run({ action: "end_surge", id: surge.id })}
        className="rounded border px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
      >
        {t("stopBtn")}
      </button>
    );
  }

  if (addSurgeZones) {
    return (
      <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
        <div className="flex flex-col text-xs">
          <label className="mb-1">{t("zoneLabel")}</label>
          <select
            value={zoneId}
            onChange={(e) => setZoneId(e.target.value)}
            className="rounded border bg-transparent px-2 py-1"
          >
            <option value="">{t("chooseOption")}</option>
            {addSurgeZones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col text-xs">
          <label className="mb-1">{t("multiplierLabel")}</label>
          <input
            value={multiplier}
            onChange={(e) => setMultiplier(e.target.value)}
            className="w-24 rounded border bg-transparent px-2 py-1"
          />
        </div>
        <div className="flex flex-col text-xs">
          <label className="mb-1">{t("durationMin")}</label>
          <input
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className="w-20 rounded border bg-transparent px-2 py-1"
          />
        </div>
        <button
          disabled={pending || !zoneId}
          onClick={() => {
            const m = Number(multiplier);
            const mins = Number(minutes);
            if (!Number.isFinite(m) || m < 1 || m > 2) {
              setErr(t("errMultiplierRange"));
              return;
            }
            run({
              action: "add_surge",
              zone_id: zoneId,
              multiplier: m,
              ends_at: Number.isFinite(mins) && mins > 0
                ? new Date(Date.now() + mins * 60_000).toISOString()
                : null,
            });
          }}
          className="rounded bg-amber-500 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
        >
          {t("startSurgeBtn")}
        </button>
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>
    );
  }

  return null;
}
