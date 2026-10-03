"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ToggleState = { active: boolean; count: number };

export type ToggleOutcome =
  | { ok: true; state: ToggleState }
  | { ok: false; reason: "unauthorized" | "blocked" | "rate_limited" | "error" };

/**
 * Comutare optimistă cu reconciliere: UI-ul se schimbă imediat, cererea e
 * idempotentă (PUT/DELETE), iar doar răspunsul ULTIMEI cereri contează — tap-uri
 * rapide nu mai lasă starea „pe dos". La eroare se revine la starea confirmată.
 */
export function useOptimisticToggle(
  initial: ToggleState,
  send: (next: boolean) => Promise<ToggleOutcome>,
  opts: { resetKey: string; onSettled?: (state: ToggleState) => void; onError?: (reason: Exclude<ToggleOutcome, { ok: true }>["reason"]) => void },
) {
  const [state, setState] = useState<ToggleState>(initial);
  const confirmed = useRef<ToggleState>(initial);
  const seq = useRef(0);
  const { onSettled, onError, resetKey } = opts;

  // Componenta poate fi refolosită pentru altă țintă (feed virtualizat). Ecoul
  // propriului onSettled (părintele re-trimite aceleași valori) nu resetează nimic.
  const lastKey = useRef(opts.resetKey);
  useEffect(() => {
    const sameTarget = lastKey.current === resetKey;
    lastKey.current = resetKey;
    const c = confirmed.current;
    if (sameTarget && c.active === initial.active && c.count === initial.count) return;
    confirmed.current = initial;
    setState(initial);
    seq.current += 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetăm doar la schimbarea țintei/valorilor inițiale
  }, [resetKey, initial.active, initial.count]);

  const current = useRef<ToggleState>(initial);
  current.current = state;

  const toggle = useCallback(async () => {
    const id = ++seq.current;
    const prev = current.current;
    const next = !prev.active;
    const optimistic = { active: next, count: Math.max(0, prev.count + (next ? 1 : -1)) };
    current.current = optimistic;
    setState(optimistic);
    const outcome = await send(next);
    if (id !== seq.current) return;
    if (outcome.ok) {
      confirmed.current = outcome.state;
      setState(outcome.state);
      onSettled?.(outcome.state);
    } else {
      setState(confirmed.current);
      onError?.(outcome.reason);
    }
  }, [send, onSettled, onError]);

  return { state, toggle };
}

/** Mapează un răspuns HTTP la un rezultat de comutare. */
export async function toggleOutcome(
  res: Response,
  read: (data: Record<string, unknown>) => ToggleState,
): Promise<ToggleOutcome> {
  if (res.status === 401) return { ok: false, reason: "unauthorized" };
  if (res.status === 403) return { ok: false, reason: "blocked" };
  if (res.status === 429) return { ok: false, reason: "rate_limited" };
  if (!res.ok) return { ok: false, reason: "error" };
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return data ? { ok: true, state: read(data) } : { ok: false, reason: "error" };
}
