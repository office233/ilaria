"use client";

import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { MessageCircle } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { isSameDay, lastSeenOwnMessageId, type ChatMessage } from "../types";
import { MessageBubble } from "./MessageBubble";

type Props = {
  messages: ChatMessage[];
  viewerId: string;
  peerLastReadAt: string | null;
  peerTyping: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry: (id: string) => void;
};

/** Lista de mesaje: separatoare pe zile, „mai vechi”, „Văzut”, indicator „scrie…”. */
export function MessageList(props: Props) {
  const { messages, viewerId, peerLastReadAt, peerTyping, hasMore, loadingOlder, onLoadOlder, onRetry } = props;
  const t = useTranslations("dm.chat");
  const format = useFormatter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const prevHeight = useRef(0);
  const prevLast = useRef<string | null>(null);

  const seenId = lastSeenOwnMessageId(messages, viewerId, peerLastReadAt);
  const lastId = messages.at(-1)?.id ?? null;

  // Mesaje mai vechi adăugate sus: păstrăm poziția de citire.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (lastId === prevLast.current && prevHeight.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    }
    prevHeight.current = el.scrollHeight;
  }, [messages.length, lastId]);

  // Mesaj nou jos (sau „scrie…”): derulăm la final.
  useEffect(() => {
    if (lastId !== prevLast.current || peerTyping) endRef.current?.scrollIntoView({ block: "end" });
    prevLast.current = lastId;
  }, [lastId, peerTyping]);

  const dayLabel = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    if (isSameDay(iso, now.toISOString())) return t("today");
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (isSameDay(iso, y.toISOString())) return t("yesterday");
    return format.dateTime(d, { day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-gutter py-3" aria-live="polite">
      {hasMore ? (
        <div className="mb-3 flex justify-center">
          <Button variant="secondary" size="sm" loading={loadingOlder} onClick={onLoadOlder}>
            {t("loadOlder")}
          </Button>
        </div>
      ) : null}
      {messages.length === 0 ? (
        <EmptyState icon={MessageCircle} title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : null}
      <div className="space-y-2">
        {messages.map((m, i) => (
          <Fragment key={m.id}>
            {i === 0 || !isSameDay(messages[i - 1].created_at, m.created_at) ? (
              <div className="flex justify-center py-2" role="separator">
                <span className="rounded-full bg-surface-2 px-3 py-1 text-xs font-semibold text-muted">
                  {dayLabel(m.created_at)}
                </span>
              </div>
            ) : null}
            <MessageBubble message={m} mine={m.sender_id === viewerId} seen={m.id === seenId} onRetry={onRetry} />
          </Fragment>
        ))}
      </div>
      {peerTyping ? (
        <p className="mt-2 text-xs font-medium text-muted" role="status">
          {t("typing")}
        </p>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
