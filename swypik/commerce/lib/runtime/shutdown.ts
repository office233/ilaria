/**
 * Oprire grațioasă a unei replici web (SIGTERM de la Docker la deploy/scale-in).
 *
 * Next standalone (`server.js`) prinde deja SIGTERM: `server.close()` nu mai
 * acceptă conexiuni noi și AȘTEAPTĂ cererile în curs, apoi `process.exit(0)`.
 * Problema sunt stream-urile SSE (DM, cursă, dispatch, chat live): nu se termină
 * niciodată singure, deci `server.close()` ar aștepta până la SIGKILL
 * (`stop_grace_period`). Aici le închidem explicit: fiecare stream trimite
 * `retry:` + un eveniment `reconnect`, iar EventSource-ul din browser se
 * reconectează — prin tunel — la o replică sănătoasă.
 *
 * `isDraining()` face `/api/ready` să răspundă 503 imediat după semnal.
 * Registrul e per-proces prin natura lui (conexiunile TCP sunt ale procesului).
 */
import { logger } from "@/lib/logger";

type Closer = () => void;

const closers = new Set<Closer>();
let draining = false;
let installed = false;

export function isDraining(): boolean {
  return draining;
}

/** Înregistrează o conexiune de lungă durată; întoarce funcția de deregistrare. */
export function onShutdown(closer: Closer): () => void {
  closers.add(closer);
  return () => {
    closers.delete(closer);
  };
}

/** Marchează replica „draining” și închide toate conexiunile lungi. Idempotent. */
export function beginShutdown(reason: string): number {
  const alreadyDraining = draining;
  draining = true;
  const count = closers.size;
  for (const close of [...closers]) {
    try {
      close();
    } catch (err) {
      logger.warn({ err }, "[shutdown] closer threw");
    }
  }
  closers.clear();
  if (!alreadyDraining) logger.info({ reason, closedStreams: count }, "[shutdown] draining replica");
  return count;
}

/** Numărul de conexiuni lungi active (pentru /api/ready și teste). */
export function openLongLivedConnections(): number {
  return closers.size;
}

/**
 * Instalează handlerele de semnal (o singură dată per proces). Handlerul lui
 * Next rămâne activ și face `server.close()` + exit; al nostru doar golește SSE-urile.
 */
export function installShutdownHandlers(): void {
  if (installed || typeof process === "undefined" || typeof process.once !== "function") return;
  installed = true;
  process.once("SIGTERM", () => beginShutdown("SIGTERM"));
  process.once("SIGINT", () => beginShutdown("SIGINT"));
}

/** Doar pentru teste. */
export function _resetShutdownState(): void {
  closers.clear();
  draining = false;
}
