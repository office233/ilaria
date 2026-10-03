"use client";

import { useEffect, useState } from "react";
import { uploadApi, type UploadStatus } from "@/lib/upload/api";
import { VIDEO_LIMITS } from "@/lib/video/limits";

const TERMINAL = new Set(["ready", "failed", "aborted"]);
type Result = { sessionId: string; pollKey: number; status: UploadStatus };

/** Poll results belong to one session and one processing attempt. */
export function useProcessingStatus(sessionId: string | null, enabled: boolean, pollKey = 0): UploadStatus | null {
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    let cancelled = false;
    let inFlight = false;
    let terminal = false;
    let lastSignature = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay: number = VIDEO_LIMITS.statusPollMinMs;
    const tick = async () => {
      if (cancelled || inFlight || terminal || document.hidden) return;
      inFlight = true;
      try {
        const next = await uploadApi.status(sessionId);
        if (cancelled) return;
        const signature = `${next.phase}:${next.stage}:${next.progress}:${next.errorCode}`;
        delay = signature === lastSignature
          ? Math.min(VIDEO_LIMITS.statusPollMaxMs, Math.round(delay * 1.5))
          : VIDEO_LIMITS.statusPollMinMs;
        lastSignature = signature;
        terminal = TERMINAL.has(next.phase);
        setResult({ sessionId, pollKey, status: next });
      } catch {
        delay = Math.min(VIDEO_LIMITS.statusPollMaxMs, delay * 2);
      } finally {
        inFlight = false;
      }
      if (!cancelled && !terminal) timer = setTimeout(tick, delay);
    };
    const onVisible = () => {
      if (!document.hidden && !cancelled && !terminal) {
        if (timer) clearTimeout(timer);
        delay = VIDEO_LIMITS.statusPollMinMs;
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, enabled, pollKey]);
  // Guard during render too: effect cleanup alone cannot hide a previous
  // attempt's cached failure/ready value before the new request completes.
  return enabled && result?.sessionId === sessionId && result?.pollKey === pollKey ? result.status : null;
}
