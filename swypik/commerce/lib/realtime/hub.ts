/**
 * Hub realtime per proces — fan-out între replici prin Redis pub/sub.
 *
 * De ce: web-next rulează în N replici identice, fără sticky sessions. Un
 * client SSE conectat la replica A trebuie să primească evenimentele publicate
 * de o cerere servită de replica B (mesaj DM, status cursă, chat live).
 * Singurul canal comun e Redis: publisherul face PUBLISH, fiecare replică are
 * UN singur abonat Redis care multiplexează canalele către ascultătorii locali.
 *
 * Înainte, fiecare stream SSE deschidea propria conexiune Redis
 * (`createSubscriber()` per client) — la 10k clienți = 10k conexiuni Redis
 * per replică. Acum: 1 conexiune de abonare per replică, SUBSCRIBE doar la
 * primul ascultător al unui canal, UNSUBSCRIBE la ultimul.
 *
 * Starea din hub (map canal → ascultători) e strict per-instanță și legată de
 * conexiunile TCP deschise pe acea instanță — exact ce trebuie să fie locală.
 * ioredis re-abonează automat canalele după o reconectare (autoResubscribe).
 */
import type { Redis } from "ioredis";
import { logger } from "@/lib/logger";

export type RealtimeListener = (message: string) => void;

export interface RealtimeHub {
  /** Abonează un ascultător local; întoarce funcția de dezabonare. */
  subscribe(channel: string, listener: RealtimeListener): Promise<() => void>;
  /** PUBLISH pe Redis (ajunge la toate replicile). `false` dacă Redis nu e disponibil. */
  publish(channel: string, payload: unknown): Promise<boolean>;
  /** Pentru metrici/teste: canale active și numărul total de ascultători locali. */
  stats(): { channels: number; listeners: number };
  /** `true` când conexiunea de abonare e conectată (altfel evenimentele se pot pierde). */
  healthy(): boolean;
}

export type HubDeps = {
  /** Conexiune dedicată de abonare (nu poate fi partajată cu comenzi normale). */
  createSubscriber: () => Redis;
  /** Conexiunea normală folosită pentru PUBLISH. */
  getPublisher: () => Redis;
};

export function createRealtimeHub(deps: HubDeps): RealtimeHub {
  const listeners = new Map<string, Set<RealtimeListener>>();
  let subscriber: Redis | null = null;

  function getSubscriber(): Redis {
    if (subscriber) return subscriber;
    const sub = deps.createSubscriber();
    sub.on("message", (channel: string, message: string) => {
      const set = listeners.get(channel);
      if (!set) return;
      for (const listener of set) {
        try {
          listener(message);
        } catch (err) {
          logger.warn({ err, channel }, "[realtime] listener threw");
        }
      }
    });
    sub.on("error", (err: unknown) => {
      logger.error({ err: err instanceof Error ? err.message : err }, "[realtime] subscriber error");
    });
    subscriber = sub;
    return sub;
  }

  async function subscribe(channel: string, listener: RealtimeListener): Promise<() => void> {
    let set = listeners.get(channel);
    const first = !set;
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(listener);
    if (first) {
      try {
        await getSubscriber().subscribe(channel);
      } catch (err) {
        set.delete(listener);
        if (set.size === 0) listeners.delete(channel);
        throw err;
      }
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size > 0) return;
      listeners.delete(channel);
      subscriber?.unsubscribe(channel).catch((err: unknown) => {
        logger.warn({ err, channel }, "[realtime] unsubscribe failed");
      });
    };
  }

  async function publish(channel: string, payload: unknown): Promise<boolean> {
    const message = typeof payload === "string" ? payload : JSON.stringify(payload);
    try {
      await deps.getPublisher().publish(channel, message);
      return true;
    } catch (err) {
      logger.warn({ err, channel }, "[realtime] publish failed");
      return false;
    }
  }

  function stats() {
    let total = 0;
    for (const set of listeners.values()) total += set.size;
    return { channels: listeners.size, listeners: total };
  }

  function healthy(): boolean {
    return subscriber?.status === "ready";
  }

  return { subscribe, publish, stats, healthy };
}
