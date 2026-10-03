/**
 * Fan-out-ul stării Live (status, spectatori, republicare) prin Redis pub/sub
 * pe canalul `live:stream:<id>`, livrat clienților prin SSE-ul existent al
 * chatului (/api/live/streams/[id]/chat, `event: state`).
 *
 * Un singur abonat Redis per proces (getSharedSubscriber) multiplexează toate
 * conexiunile SSE: 1.000 de spectatori ≠ 1.000 de conexiuni Redis.
 */
import { logger } from "@/lib/logger";
import { getRedis, getSharedSubscriber } from "@/lib/redis";
import type { LiveStatus } from "./queries";

export type LiveStateEvent = {
  status: LiveStatus;
  viewers?: number;
  /** Se schimbă când gazda republică (reconectare) → spectatorii trag din nou. */
  publishedAt?: string | null;
};

export const liveChannel = (streamId: string) => `live:stream:${streamId}`;

export async function publishLiveState(streamId: string, state: LiveStateEvent): Promise<void> {
  try {
    await getRedis().publish(liveChannel(streamId), JSON.stringify(state));
  } catch (err) {
    // Clienții au și poll-ul de siguranță; fan-out-ul nu blochează ciclul de viață.
    logger.warn({ err, streamId }, "[live/events] publish failed");
  }
}

type Listener = (state: LiveStateEvent) => void;
const listeners = new Map<string, Set<Listener>>();
let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  getSharedSubscriber().on("message", (channel: string, message: string) => {
    const set = listeners.get(channel);
    if (!set || set.size === 0) return;
    let state: LiveStateEvent;
    try {
      state = JSON.parse(message) as LiveStateEvent;
    } catch {
      return;
    }
    for (const fn of set) fn(state);
  });
}

/** Abonare la starea unui stream; întoarce funcția de dezabonare. */
export async function subscribeLiveState(streamId: string, fn: Listener): Promise<() => void> {
  wire();
  const channel = liveChannel(streamId);
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
    await getSharedSubscriber().subscribe(channel);
  }
  set.add(fn);
  return () => {
    const current = listeners.get(channel);
    if (!current) return;
    current.delete(fn);
    if (current.size === 0) {
      listeners.delete(channel);
      void getSharedSubscriber().unsubscribe(channel).catch(() => undefined);
    }
  };
}
