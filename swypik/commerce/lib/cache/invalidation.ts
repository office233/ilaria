/**
 * Invalidare cross-replică pentru cache-urile mici din memorie (config citit
 * din DB, cu TTL). Un `cache = null` local golește doar replica care a servit
 * scrierea; celelalte ar servi valoarea veche până la expirarea TTL-ului.
 * `broadcastCacheInvalidate(name)` golește local imediat și publică numele pe
 * canalul Redis `cache:invalidate`; fiecare replică rulează handlerele locale.
 *
 * Best-effort: fără Redis, celelalte replici se aliniază la expirarea TTL-ului
 * (cache-urile care folosesc asta TREBUIE să aibă TTL).
 */
import { logger } from "@/lib/logger";
import { getRealtimeHub, realtimeChannels } from "@/lib/realtime";

const handlers = new Map<string, Set<() => void>>();
let subscribed: Promise<void> | null = null;

function runLocal(name: string): void {
  for (const fn of handlers.get(name) ?? []) {
    try {
      fn();
    } catch (err) {
      logger.warn({ err, name }, "[cache-invalidate] handler threw");
    }
  }
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = getRealtimeHub()
    .subscribe(realtimeChannels.cacheInvalidate, (name) => runLocal(name))
    .then(() => undefined)
    .catch((err) => {
      // Fără Redis: rămânem pe TTL; reîncercăm la următoarea înregistrare.
      logger.warn({ err }, "[cache-invalidate] subscribe failed — TTL only");
      subscribed = null;
    });
}

/** Înregistrează un handler local pentru `name` (idempotent pe aceeași funcție). */
export function onCacheInvalidate(name: string, fn: () => void): void {
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
  }
  set.add(fn);
  ensureSubscribed();
}

/** Golește cache-ul `name` pe replica curentă imediat și pe celelalte prin Redis. */
export async function broadcastCacheInvalidate(name: string): Promise<void> {
  runLocal(name);
  try {
    await getRealtimeHub().publish(realtimeChannels.cacheInvalidate, name);
  } catch {
    /* publish() nu aruncă; defensiv */
  }
}
