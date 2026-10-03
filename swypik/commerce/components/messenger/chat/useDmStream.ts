"use client";

import { useEffect, useRef } from "react";
import type { DmStreamEvent, MessageRow } from "@/lib/dm/types";

/** Normalizează payload-ul SSE (evenimente tipizate + formatul vechi = mesaj brut). */
export function parseDmEvent(raw: string): DmStreamEvent | null {
  try {
    const data = JSON.parse(raw) as Partial<DmStreamEvent> & Partial<MessageRow>;
    if (data.type === "message" || data.type === "read" || data.type === "typing") return data as DmStreamEvent;
    if (data.id && data.sender_id) return { type: "message", message: data as MessageRow };
    return null;
  } catch {
    return null;
  }
}

/**
 * Abonare SSE la `/api/dm/stream/<id>` (Redis pub/sub). EventSource se
 * reconectează singur; handler-ul e ținut într-un ref ca să nu redeschidă
 * conexiunea la fiecare randare.
 */
export function useDmStream(conversationId: string, onEvent: (event: DmStreamEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const es = new EventSource(`/api/dm/stream/${conversationId}`);
    es.onmessage = (e: MessageEvent<string>) => {
      const event = parseDmEvent(e.data);
      if (event) handler.current(event);
    };
    return () => es.close();
  }, [conversationId]);
}
