"use client";

/**
 * Prompt de permisiuni (locație + notificări) afișat la PRIMUL acces pe o
 * verticală care are nevoie de ele (Eats/Go) — nu la deschiderea aplicației.
 * Explică pe scurt de ce sunt necesare; refuzul e memorat în localStorage.
 */
import { useEffect, useState } from "react";
import { MapPin, Bell, X } from "lucide-react";
import { haptic } from "@/lib/haptic";
import { useTranslations } from "next-intl";

const STORAGE_KEY = "swypik_perms_prompted_v1";

type Props = {
  /** identifică verticala pentru textul explicativ */
  vertical: "eats" | "go";
};

export default function PermissionsPrompt({ vertical }: Props) {
  const t = useTranslations("permissionsPrompt");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (localStorage.getItem(STORAGE_KEY)) return;
    } catch {
      return;
    }
    // Afișăm doar dacă cel puțin una din permisiuni e încă „default".
    const needsPush = typeof Notification !== "undefined" && Notification.permission === "default";
    let cancelled = false;
    const decide = (needsGeo: boolean) => {
      if (!cancelled && (needsGeo || needsPush)) setVisible(true);
    };
    if (navigator.permissions?.query) {
      navigator.permissions
        .query({ name: "geolocation" })
        .then((st) => decide(st.state === "prompt"))
        .catch(() => decide(true));
    } else {
      decide(true);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  const copy =
    vertical === "eats"
      ? { title: t("eatsTitle"), location: t("eatsLocation"), push: t("eatsPush") }
      : { title: t("goTitle"), location: t("goLocation"), push: t("goPush") };

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      /* noop */
    }
    setVisible(false);
  };

  const accept = async () => {
    haptic("tap");
    setBusy(true);
    try {
      // 1. Locație — declanșează promptul nativ.
      await new Promise<void>((resolve) => {
        if (!navigator.geolocation) return resolve();
        navigator.geolocation.getCurrentPosition(
          () => resolve(),
          () => resolve(),
          { timeout: 8000 },
        );
      });
      // 2. Notificări.
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        await Notification.requestPermission().catch(() => undefined);
      }
    } finally {
      setBusy(false);
      dismiss();
    }
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 p-4 pb-[calc(72px+env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-lg rounded-2xl border border-[#E5E5E5] dark:border-[#2A2A2A] bg-white dark:bg-[#111] shadow-xl p-4">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h2 className="text-sm font-bold">{copy.title}</h2>
          <button type="button" aria-label={t("close")} onClick={dismiss} className="text-[#A1A1AA] -mt-1 -mr-1 p-1">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-2 mb-3">
          <p className="flex items-start gap-2 text-xs text-[#71717A]">
            <MapPin size={14} className="mt-0.5 shrink-0 text-[#7C3AED]" /> {copy.location}
          </p>
          <p className="flex items-start gap-2 text-xs text-[#71717A]">
            <Bell size={14} className="mt-0.5 shrink-0 text-[#7C3AED]" /> {copy.push}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={accept}
            disabled={busy}
            className="flex-1 rounded-full bg-[#7C3AED] text-white py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            {busy ? t("enabling") : t("enable")}
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="rounded-full border border-[#E5E5E5] dark:border-[#2A2A2A] px-4 py-2.5 text-sm font-medium"
          >
            {t("later")}
          </button>
        </div>
      </div>
    </div>
  );
}
