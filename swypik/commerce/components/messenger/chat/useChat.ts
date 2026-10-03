"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DmStreamEvent, MessageRow } from "@/lib/dm/types";
import type { ChatMessage, ConversationDetail } from "../types";
import { useDmStream } from "./useDmStream";

const TYPING_TTL_MS = 4000;
const TYPING_PING_MS = 2500;

type SendResult = { ok: true } | { ok: false; code: string };

function toChat(m: MessageRow): ChatMessage {
  return { id: m.id, sender_id: m.sender_id, body: m.body, media_url: m.media_url, created_at: m.created_at };
}

/** Adaugă/înlocuiește un mesaj confirmat: dedup după id, înlocuiește bula optimistă. */
export function mergeIncoming(list: ChatMessage[], msg: ChatMessage, tempId?: string): ChatMessage[] {
  if (list.some((m) => m.id === msg.id)) return tempId ? list.filter((m) => m.id !== tempId) : list;
  if (tempId && list.some((m) => m.id === tempId)) return list.map((m) => (m.id === tempId ? msg : m));
  const pendingIdx = list.findIndex(
    (m) => m.pending && m.sender_id === msg.sender_id && m.body === msg.body && !m.file === !msg.media_url,
  );
  if (pendingIdx >= 0) return list.map((m, i) => (i === pendingIdx ? msg : m));
  return [...list, msg];
}

async function postJson(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function useChat(conversationId: string, viewerId: string, pageSize: number) {
  const base = `/api/dm/conversations/${conversationId}`;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [peerTyping, setPeerTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPing = useRef(0);

  const markRead = useCallback(() => {
    postJson(`${base}/read`).catch(() => undefined);
  }, [base]);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const [d, m] = await Promise.all([fetch(base), fetch(`${base}/messages?limit=${pageSize}`)]);
      if (!d.ok || !m.ok) throw new Error(String(d.status || m.status));
      const dj = (await d.json()) as { conversation: ConversationDetail };
      const mj = (await m.json()) as { messages: MessageRow[] };
      setDetail(dj.conversation);
      setMessages(mj.messages.map(toChat));
      setHasMore(mj.messages.length >= pageSize);
      setStatus("ready");
      markRead();
    } catch {
      setStatus("error");
    }
  }, [base, pageSize, markRead]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }, []);

  useDmStream(conversationId, (event: DmStreamEvent) => {
    if (event.type === "message") {
      setMessages((prev) => mergeIncoming(prev, toChat(event.message)));
      if (event.message.sender_id !== viewerId) {
        setPeerTyping(false);
        if (document.visibilityState === "visible") markRead();
      }
    } else if (event.type === "read" && event.user_id !== viewerId) {
      setDetail((d) => (d ? { ...d, peer_last_read_at: event.last_read_at } : d));
    } else if (event.type === "typing" && event.user_id !== viewerId) {
      setPeerTyping(true);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => setPeerTyping(false), TYPING_TTL_MS);
    }
  });

  const loadOlder = useCallback(async () => {
    const oldest = messages.find((m) => !m.pending && !m.failed);
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const r = await fetch(`${base}/messages?limit=${pageSize}&before=${encodeURIComponent(oldest.created_at)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { messages: MessageRow[] };
      setMessages((prev) => [...j.messages.map(toChat).filter((m) => !prev.some((p) => p.id === m.id)), ...prev]);
      setHasMore(j.messages.length >= pageSize);
    } finally {
      setLoadingOlder(false);
    }
  }, [base, messages, loadingOlder, pageSize]);

  const deliver = useCallback(
    async (tempId: string, body: string, file: File | null): Promise<SendResult> => {
      let res: Response;
      try {
        if (file) {
          const form = new FormData();
          form.append("file", file);
          form.append("caption", body);
          res = await fetch(`${base}/attachments`, { method: "POST", body: form });
        } else {
          res = await postJson(`${base}/messages`, { body });
        }
      } catch {
        res = new Response(null, { status: 0 });
      }
      const data = (await res.json().catch(() => ({}))) as { message?: MessageRow; error?: string };
      if (res.ok && data.message) {
        setMessages((prev) => mergeIncoming(prev, toChat(data.message as MessageRow), tempId));
        return { ok: true };
      }
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)));
      return { ok: false, code: data.error ?? "network" };
    },
    [base],
  );

  const send = useCallback(
    (body: string, file: File | null = null): Promise<SendResult> => {
      const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const optimistic: ChatMessage = {
        id: tempId,
        sender_id: viewerId,
        body,
        media_url: file ? URL.createObjectURL(file) : null,
        created_at: new Date().toISOString(),
        pending: true,
        file,
      };
      setMessages((prev) => [...prev, optimistic]);
      return deliver(tempId, body, file);
    },
    [viewerId, deliver],
  );

  const retry = useCallback(
    (tempId: string) => {
      const msg = messages.find((m) => m.id === tempId);
      if (!msg) return;
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: true, failed: false } : m)));
      void deliver(tempId, msg.body, msg.file ?? null);
    },
    [messages, deliver],
  );

  const pingTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastPing.current < TYPING_PING_MS) return;
    lastPing.current = now;
    postJson(`${base}/typing`).catch(() => undefined);
  }, [base]);

  return { messages, detail, setDetail, status, hasMore, loadingOlder, peerTyping, load, loadOlder, send, retry, pingTyping };
}
