"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { haptic } from "@/lib/haptic";

export type ToggleResult = { on: boolean; count: number };

type Options = {
  on: boolean;
  count: number;
  /** Cererea reală; întoarce starea confirmată de server. Aruncă `"unauthorized"` la 401. */
  request: (next: boolean) => Promise<ToggleResult>;
  onChange?: (state: ToggleResult) => void;
  onError?: () => void;
  /** Ruta la care revine userul după login. */
  loginNext: string;
};

/** Toggle optimist reconciliat cu serverul; rollback la eroare, login la 401. */
export function useToggleAction({ on, count, request, onChange, onError, loginNext }: Options) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const toggle = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    haptic("tap");
    const prev = { on, count };
    const next = !on;
    onChange?.({ on: next, count: Math.max(0, count + (next ? 1 : -1)) });
    try {
      onChange?.(await request(next));
    } catch (err) {
      onChange?.(prev);
      if (err instanceof Error && err.message === "unauthorized") {
        router.push(`/auth/login?next=${encodeURIComponent(loginNext)}`);
      } else {
        onError?.();
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [on, count, request, onChange, onError, loginNext, router]);

  return { toggle, busy };
}

export async function postToggle(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "POST" });
  if (res.status === 401) throw new Error("unauthorized");
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "request_failed");
  return data;
}
