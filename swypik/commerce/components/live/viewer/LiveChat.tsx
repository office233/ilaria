"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Send } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/Avatar";
import { IconButton } from "@/components/ui/IconButton";
import { useToast } from "@/components/ui/Toast";
import { ChatMessageActions, type ChatMsg } from "./ChatMessageActions";
import type { LiveTipPublic } from "@/lib/live/tips";

/** Starea streamului publicată prin același SSE (`event: state`, Redis `live:stream:<id>`). */
export type LiveStateUpdate = {
  status: "scheduled" | "live" | "ended" | "failed";
  viewers?: number;
  publishedAt?: string | null;
};

const MAX_VISIBLE = 50;
/** Erori de trimitere cu mesaj dedicat în `live.chat.errors.*`. */
const SEND_ERRORS = new Set(["message_blocked", "chat_banned", "moderation_unavailable", "stream_not_live"]);

/** Chat suprapus peste video (SSE din /api/live/streams/[id]/chat). `isHost` = gazda poate ascunde/bloca. */
type Props = { streamId: string; canChat: boolean; signedIn: boolean; isHost?: boolean; onState?: (state: LiveStateUpdate) => void };

export function LiveChat({ streamId, canChat, signedIn, isHost = false, onState }: Props) {
  const t = useTranslations("live.chat");
  const tTips = useTranslations("live.tips");
  const locale = useLocale();
  const { toast } = useToast();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState<ChatMsg | null>(null);
  const [tips, setTips] = useState<LiveTipPublic[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    const es = new EventSource(`/api/live/streams/${streamId}/chat`);
    es.addEventListener("chat", (e: MessageEvent<string>) => {
      try {
        const m = JSON.parse(e.data) as ChatMsg;
        setMessages((prev) => (prev.some((p) => p.id === m.id) ? prev : [...prev.slice(-(MAX_VISIBLE - 1)), m]));
      } catch {
        // payload invalid — ignorat
      }
    });
    es.addEventListener("remove", (e: MessageEvent<string>) => {
      try {
        const ids = new Set((JSON.parse(e.data) as { ids: number[] }).ids.map(Number));
        setMessages((prev) => prev.filter((m) => !ids.has(Number(m.id))));
      } catch {
        // payload invalid — ignorat
      }
    });
    es.addEventListener("state", (e: MessageEvent<string>) => {
      try {
        onStateRef.current?.(JSON.parse(e.data) as LiveStateUpdate);
      } catch {
        // payload invalid — ignorat
      }
    });
    es.addEventListener("tip", (e: MessageEvent<string>) => {
      try {
        const tip = JSON.parse(e.data) as LiveTipPublic;
        if (tip.kind !== "tip") return;
        setTips((prev) => (prev.some((item) => item.id === tip.id) ? prev : [...prev.slice(-9), tip]));
      } catch {
        // payload invalid — ignorat
      }
    });
    return () => es.close();
  }, [streamId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const msg = text.trim();
    if (!msg || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/live/streams/${streamId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      if (res.ok) {
        setText("");
      } else {
        const code = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "";
        const title = res.status === 429 ? t("slowDown") : SEND_ERRORS.has(code) ? t(`errors.${code}`) : t("sendFailed");
        toast({ title, tone: "danger" });
      }
    } catch {
      toast({ title: t("sendFailed"), tone: "danger" });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="pointer-events-auto flex max-h-[40dvh] flex-col">
      <div
        className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-16 [mask-image:linear-gradient(to_bottom,transparent,black_24px)]"
        aria-live="polite"
        aria-label={t("label")}
      >
        {messages.map((m) => {
          const name = m.display_name || (m.username ? `@${m.username}` : t("anonymous"));
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => signedIn && setSelected(m)}
              disabled={!signedIn}
              aria-label={signedIn ? t("messageActions", { name }) : undefined}
              className="flex w-fit max-w-full items-start gap-1.5 rounded-control bg-black/35 px-2.5 py-1 text-left text-sm text-white backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 disabled:cursor-default"
            >
              <Avatar src={m.avatar_url} name={name} size="xs" className="mt-px" />
              <span className="min-w-0 break-words">
                <span className="mr-1.5 font-semibold text-white/80">{name}</span>
                {m.message}
              </span>
            </button>
          );
        })}
        {tips.map((tip) => {
          const name = tip.display_name || (tip.username ? `@${tip.username}` : t("anonymous"));
          const amount = new Intl.NumberFormat(locale, { style: "currency", currency: tip.currency }).format(
            tip.amount_cents / 100,
          );
          return (
            <div key={`tip:${tip.id}`} className="w-fit max-w-full rounded-full bg-warning/90 px-3 py-1 text-sm font-semibold text-black">
              {tTips("received", { name, amount })}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {canChat ? (
        signedIn ? (
          <form onSubmit={send} className="mt-2 flex items-center gap-2">
            <label htmlFor="live-chat-input" className="sr-only">
              {t("placeholder")}
            </label>
            <input
              id="live-chat-input"
              value={text}
              maxLength={500}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("placeholder")}
              className="min-h-11 flex-1 rounded-full border border-white/20 bg-black/40 px-4 text-base text-white placeholder:text-white/60 backdrop-blur focus-visible:outline-none focus-visible:ring-2"
            />
            <IconButton type="submit" variant="overlay" label={t("send")} disabled={!text.trim() || sending}>
              <Send aria-hidden />
            </IconButton>
          </form>
        ) : (
          <Link
            href={`/auth?next=${encodeURIComponent(`/live/${streamId}`)}`}
            className="mt-2 inline-flex min-h-11 w-fit items-center rounded-full bg-black/40 px-4 text-sm font-semibold text-white backdrop-blur"
          >
            {t("signInToChat")}
          </Link>
        )
      ) : null}
      <ChatMessageActions streamId={streamId} message={selected} isHost={isHost} onClose={() => setSelected(null)} />
    </div>
  );
}
