/**
 * Răspuns SSE comun pentru toate stream-urile (DM, dispatch, cursă, chat live).
 *
 * - evenimentele vin prin hub-ul realtime (Redis pub/sub → orice replică);
 * - `onOpen` trimite snapshot-ul / catch-up-ul din DB (sursa de adevăr), deci
 *   un client reconectat pe altă replică nu pierde starea;
 * - `poll` = plasă de siguranță opțională (ex. chat live) dacă Redis cade;
 * - heartbeat-ul ține conexiunea vie prin tunel/proxy;
 * - la SIGTERM (`lib/runtime/shutdown`) stream-ul trimite `event: reconnect`
 *   și se închide, ca `server.close()` al lui Next să poată termina.
 */
import { logger } from "@/lib/logger";
import { onShutdown } from "@/lib/runtime/shutdown";
import type { RealtimeHub } from "./hub";
import { getRealtimeHub } from "./index";

export type SseSend = (data: unknown, opts?: { event?: string; id?: string | number }) => void;

export type SseOptions = {
  logTag: string;
  channels?: string[];
  /** Implicit: payload-ul Redis (deja JSON) e trimis ca `data:`. */
  onMessage?: (channel: string, raw: string, send: SseSend, sendRaw: (chunk: string) => void) => void;
  onOpen?: (send: SseSend) => Promise<void> | void;
  poll?: { intervalMs: number; run: (send: SseSend) => Promise<void> };
  /** Dacă abonarea Redis eșuează: `true` → eveniment `error` + închidere. */
  requireRealtime?: boolean;
  heartbeatMs?: number;
  retryMs?: number;
  signal?: AbortSignal;
  hub?: RealtimeHub;
};

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export function formatSseEvent(data: unknown, opts: { event?: string; id?: string | number } = {}): string {
  const lines: string[] = [];
  if (opts.id !== undefined) lines.push(`id: ${opts.id}`);
  if (opts.event) lines.push(`event: ${opts.event}`);
  const body = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of body.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

export function createSseResponse(opts: SseOptions): Response {
  const encoder = new TextEncoder();
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const cleanups: Array<() => void> = [];
  let closed = false;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;

  const sendRaw = (chunk: string) => {
    if (closed || !ctrl) return;
    try {
      ctrl.enqueue(encoder.encode(chunk));
    } catch {
      closed = true;
    }
  };
  const send: SseSend = (data, eventOpts) => sendRaw(formatSseEvent(data, eventOpts));

  const close = () => {
    if (closed) return;
    closed = true;
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* best-effort */
      }
    }
    try {
      ctrl?.close();
    } catch {
      /* deja închis */
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      ctrl = controller;
      sendRaw(`retry: ${opts.retryMs ?? 3000}\n\n`);
      cleanups.push(
        onShutdown(() => {
          sendRaw(formatSseEvent({ reason: "shutdown" }, { event: "reconnect" }));
          close();
        }),
      );
      if (opts.signal) {
        if (opts.signal.aborted) return close();
        const onAbort = () => close();
        opts.signal.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => opts.signal?.removeEventListener("abort", onAbort));
      }

      const hub = opts.hub ?? getRealtimeHub();
      for (const channel of opts.channels ?? []) {
        try {
          const unsubscribe = await hub.subscribe(channel, (raw) => {
            if (opts.onMessage) opts.onMessage(channel, raw, send, sendRaw);
            else sendRaw(`data: ${raw}\n\n`);
          });
          if (closed) unsubscribe();
          else cleanups.push(unsubscribe);
        } catch (err) {
          logger.error({ err: err instanceof Error ? err.message : err, channel }, `[${opts.logTag}] subscribe failed`);
          if (opts.requireRealtime) {
            send({ message: "subscribe failed" }, { event: "error" });
            return close();
          }
        }
      }

      if (opts.onOpen) {
        try {
          await opts.onOpen(send);
        } catch (err) {
          logger.warn({ err }, `[${opts.logTag}] snapshot failed`);
        }
      }

      if (closed) return;
      const heartbeat = setInterval(() => sendRaw(": ping\n\n"), heartbeatMs);
      cleanups.push(() => clearInterval(heartbeat));
      if (opts.poll) {
        const poll = opts.poll;
        let running = false;
        const timer = setInterval(() => {
          if (running || closed) return;
          running = true;
          poll
            .run(send)
            .catch((err) => logger.warn({ err }, `[${opts.logTag}] poll failed`))
            .finally(() => {
              running = false;
            });
        }, poll.intervalMs);
        cleanups.push(() => clearInterval(timer));
      }
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
