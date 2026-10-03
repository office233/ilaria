"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { useTranslations } from "next-intl";
import { useToast } from "@/components/ui/Toast";

/**
 * Butoanele de apel apar doar când Cloudflare RealtimeKit e configurat la build
 * (NEXT_PUBLIC_CALLS_ENABLED=1). Serverul răspunde oricum 503 fără chei.
 */
export const CALLS_ENABLED = process.env.NEXT_PUBLIC_CALLS_ENABLED === "1";
/** Plasă de siguranță când SSE-ul nu merge (proxy, Redis căzut). */
const FALLBACK_POLL_MS = 15_000;
/** Coduri de eroare cu mesaj dedicat în `messenger.calls.errors.*`. */
const CALL_ERRORS = new Set(["not_participant", "call_inactive", "call_not_found", "caller_cannot_decline", "rate_limited", "calls_provider_error"]);
/** Răspunsuri la sonda inițială după care nu are sens SSE (fără cont / Messenger oprit). */
const NO_STREAM_STATUSES = new Set([401, 403, 404, 410]);

/** Câte GlobalCallHost sunt montate: dacă există unul, ecranele locale (ChatScreen) nu mai sună și ele. */
let globalHosts = 0;

export type ActiveCall = { authToken: string; callType: "audio" | "video"; callId: string };
export type IncomingCall = {
  id: string;
  conversation_id: string;
  call_type: "audio" | "video";
  caller: { id: string; username: string | null; display_name: string | null; avatar_url: string | null };
};

/**
 * Apeluri primite: SSE (/api/messenger/calls/stream — `calls` / `stop`) cu poll
 * rar de rezervă dacă SSE-ul cade. `global` = GlobalCallHost (tot app-ul).
 */
function useIncomingCalls(mode: "global" | "local", busy: boolean, dismissed: MutableRefObject<Set<string>>) {
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!CALLS_ENABLED) return;
    if (mode === "global") globalHosts += 1;
    let cancelled = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const pick = (calls: IncomingCall[] | undefined) => {
      if (busyRef.current || cancelled) return;
      const call = calls?.find((c) => !dismissed.current.has(c.id)) ?? null;
      setIncoming((cur) => (cur && calls?.some((c) => c.id === cur.id) ? cur : call));
    };
    const poll = async (): Promise<number> => {
      try {
        const res = await fetch("/api/messenger/calls/incoming");
        if (res.ok) pick(((await res.json()) as { calls?: IncomingCall[] }).calls);
        return res.status;
      } catch {
        return 0; // rețea — următorul tick
      }
    };
    const startPolling = () => {
      if (!timer) timer = setInterval(() => void poll(), FALLBACK_POLL_MS);
    };
    const openStream = () => {
      if (typeof EventSource === "undefined") return startPolling();
      const source = new EventSource("/api/messenger/calls/stream");
      es = source;
      source.addEventListener("calls", (e: MessageEvent<string>) => {
        try {
          pick((JSON.parse(e.data) as { calls?: IncomingCall[] }).calls);
        } catch {
          // payload invalid
        }
      });
      source.addEventListener("stop", (e: MessageEvent<string>) => {
        try {
          const { callId } = JSON.parse(e.data) as { callId: string };
          setIncoming((cur) => (cur?.id === callId ? null : cur));
        } catch {
          // payload invalid
        }
      });
      source.onerror = startPolling;
    };

    // Pornire după commit (efectele copiilor rulează înaintea părintelui): un host
    // global montat în același render e deja numărat, iar ecranul local nu dublează soneria.
    const boot = setTimeout(() => {
      if (cancelled || (mode === "local" && globalHosts > 0)) return;
      // Sondă inițială: vizitatorii fără cont (401) sau Messenger oprit nu deschid SSE.
      void poll().then((status) => {
        if (!cancelled && !NO_STREAM_STATUSES.has(status)) openStream();
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(boot);
      if (mode === "global") globalHosts -= 1;
      es?.close();
      if (timer) clearInterval(timer);
    };
  }, [mode, dismissed]);

  return [incoming, setIncoming] as const;
}

/**
 * Pornire/acceptare/refuz apel. `global` = GlobalCallHost (soneria din tot app-ul);
 * altfel (ChatScreen) sună local doar dacă nu e montat niciun host global.
 */
export function useCalls({ global = false }: { global?: boolean } = {}) {
  const t = useTranslations("messenger.calls");
  const { toast } = useToast();
  const [active, setActive] = useState<ActiveCall | null>(null);
  const dismissed = useRef<Set<string>>(new Set());
  const [incoming, setIncoming] = useIncomingCalls(global ? "global" : "local", active !== null, dismissed);

  const errorText = useCallback(
    (code: string | undefined) => (code && CALL_ERRORS.has(code) ? t(`errors.${code}`) : t("startError", { error: t("unknownError") })),
    [t],
  );

  const start = useCallback(
    async (callType: "audio" | "video", conversationId?: string, callId?: string) => {
      try {
        const res = await fetch("/api/messenger/calls/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(callId ? { callId } : { conversationId, callType }),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<ActiveCall> & { error?: string };
        if (res.ok && data.authToken && data.callId) {
          setActive({ authToken: data.authToken, callType: data.callType ?? callType, callId: data.callId });
        } else if (res.status === 503) {
          toast({ title: t("unavailable"), tone: "danger" });
        } else {
          toast({ title: errorText(data.error), tone: "danger" });
        }
      } catch {
        toast({ title: t("networkError"), tone: "danger" });
      }
    },
    [t, toast, errorText],
  );

  const accept = useCallback(() => {
    if (!incoming) return;
    const call = incoming;
    dismissed.current.add(call.id);
    setIncoming(null);
    void start(call.call_type, undefined, call.id);
  }, [incoming, start, setIncoming]);

  const decline = useCallback(() => {
    if (!incoming) return;
    dismissed.current.add(incoming.id);
    fetch(`/api/messenger/calls/${incoming.id}/decline`, { method: "POST" }).catch(() => undefined);
    setIncoming(null);
  }, [incoming, setIncoming]);

  const end = useCallback(() => {
    if (active) fetch(`/api/messenger/calls/${active.callId}/end`, { method: "POST" }).catch(() => undefined);
    setActive(null);
  }, [active]);

  return { active, incoming, start, accept, decline, end };
}
