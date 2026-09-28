/**
 * Polling simplu, testabil: rulează `fn` până când `done(rezultat)` e true
 * sau se epuizează încercările. Folosit după confirmarea plății, până când
 * webhook-ul Stripe marchează deblocarea plătită (fără cursa „paywall din nou").
 */
export const UNLOCK_POLL_ATTEMPTS = 20;
export const UNLOCK_POLL_INTERVAL_MS = 1500;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function pollUntil<T>(
    fn: () => Promise<T>,
    done: (value: T) => boolean,
    opts: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<T | null> {
    const attempts = opts.attempts ?? UNLOCK_POLL_ATTEMPTS;
    const intervalMs = opts.intervalMs ?? UNLOCK_POLL_INTERVAL_MS;
    const sleep = opts.sleep ?? defaultSleep;
    for (let i = 0; i < attempts; i++) {
        if (opts.signal?.aborted) return null;
        try {
            const value = await fn();
            if (done(value)) return value;
        } catch {
            // o eroare de rețea trecătoare nu oprește așteptarea
        }
        if (i < attempts - 1) await sleep(intervalMs);
    }
    return null;
}
