"use client";

import { useEffect, useRef } from "react";
import { liveApi, LiveRtcError, type LivePulse } from "./client";

/** Erori după care nu mai are sens să trimitem heartbeat (sesiunea nu mai e validă). */
const FATAL = new Set(["stream_ended", "session_replaced", "forbidden", "not_found", "unauthorized"]);

/**
 * Heartbeat periodic pentru gazdă sau spectator. Primul puls pleacă imediat
 * (gazda trece din scheduled în live fără să aștepte un interval) și încă unul
 * la revenirea din fundal.
 */
export function useHeartbeat(
  streamId: string,
  role: "host" | "viewer",
  sessionId: string | null,
  intervalMs: number,
  onPulse: (pulse: LivePulse) => void,
  onFatal: (code: string) => void,
): void {
  const handlers = useRef({ onPulse, onFatal });
  handlers.current = { onPulse, onFatal };

  useEffect(() => {
    if (!sessionId) return;
    let stopped = false;
    const beat = async () => {
      try {
        const pulse = await liveApi<LivePulse>(streamId, "heartbeat", { method: "POST", body: { role, sessionId } });
        if (!stopped) handlers.current.onPulse(pulse);
      } catch (err) {
        const code = err instanceof LiveRtcError ? err.code : "unknown";
        if (!stopped && FATAL.has(code)) {
          stopped = true;
          handlers.current.onFatal(code);
        }
        // rețea / 5xx: următorul puls reîncearcă (TTL-ul tolerează câteva ratări)
      }
    };
    void beat();
    const timer = setInterval(() => void beat(), intervalMs);
    // App în fundal (mobil): timerele sunt înghețate; la revenire trimitem imediat
    // un puls — serverul ține gazda LIVE_HOST_GRACE_SEC fără heartbeat (nu încheie streamul).
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [streamId, role, sessionId, intervalMs]);
}
