"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  getPushSubscriptionState,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push/subscribe";

type State =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "denied" }
  | { kind: "ready"; subscribed: boolean };

export default function PushDeviceToggle() {
  const t = useTranslations("pushDeviceToggle");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isPushSupported()) {
      setState({ kind: "unsupported" });
      return;
    }
    const s = await getPushSubscriptionState();
    if (s.permission === "denied") setState({ kind: "denied" });
    else setState({ kind: "ready", subscribed: s.subscribed && s.permission === "granted" });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onToggle = useCallback(async () => {
    if (state.kind !== "ready") return;
    setBusy(true);
    setMsg(null);
    if (state.subscribed) {
      const r = await unsubscribeFromPush();
      setMsg(r.ok ? "Dezactivate" : "Eroare la dezactivare");
    } else {
      const r = await subscribeToPush();
      if (r.ok) setMsg("Activate");
      else if (r.reason === "denied") setMsg("Permisiune refuzată");
      else setMsg("Nu am putut activa");
    }
    await refresh();
    setBusy(false);
    window.setTimeout(() => setMsg(null), 2000);
  }, [state, refresh]);

  if (state.kind === "loading") {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-white/60">
        <Loader2 size={14} className="animate-spin" />  {t("seVerifica")}
      </span>
    );
  }
  if (state.kind === "unsupported") {
    return <p className="text-xs text-white/50">{t("browserulNuSuportaNotificari")}</p>;
  }
  if (state.kind === "denied") {
    return (
      <p className="text-xs text-white/60">
        
        {t("permisiuneRefuzataActiveazaDin")}
      </p>
    );
  }

  const on = state.subscribed;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-2 text-sm text-white">
        {on ? <Bell size={14} /> : <BellOff size={14} />}
        {on ? "Notificări active" : "Notificări dezactivate"}
      </span>
      <div className="flex items-center gap-3">
        {msg && <span className="text-xs text-white/70">{msg}</span>}
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          aria-pressed={on}
          aria-label={on ? "Dezactivează notificările" : "Activează notificările"}
          className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-60 ${on ? "bg-[#7C3AED]" : "bg-white/20"}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${on ? "translate-x-5" : "translate-x-0.5"}`}
          />
        </button>
      </div>
    </div>
  );
}
