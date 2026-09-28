"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Ban } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/ui/cn";
import IncomingCallDialog from "../Calls/IncomingCallDialog";
import { CALLS_ENABLED, useCalls } from "../Calls/useCalls";
import { peerName } from "../types";
import { ChatHeader } from "./ChatHeader";
import { ChatSafetySheet } from "./ChatSafetySheet";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { useChat } from "./useChat";

// SDK-ul RealtimeKit (greu) se încarcă doar când pornește un apel.
const ActiveCallOverlay = dynamic(() => import("../Calls/ActiveCallOverlay"), { ssr: false });

export type ChatLimits = { maxBody: number; pageSize: number; maxImageMb: number };

type Props = { conversationId: string; viewerId: string; limits: ChatLimits };

/**
 * Ecranul de conversație: înălțime = 100dvh minus zona de jos rezervată
 * (BottomNav e ascuns aici, deci doar safe-area) — compozitorul nu mai stă sub bară.
 */
export default function ChatScreen({ conversationId, viewerId, limits }: Props) {
  const t = useTranslations("dm.chat");
  const { toast } = useToast();
  const chat = useChat(conversationId, viewerId, limits.pageSize);
  const calls = useCalls();
  const [safetyOpen, setSafetyOpen] = useState(false);
  const detail = chat.detail;
  const blocked = Boolean(detail?.blocked_by_me || detail?.blocked_me);

  const onSend = async (body: string, file: File | null) => {
    const res = await chat.send(body, file);
    if (!res.ok && res.code === "blocked") toast({ title: t("blockedError"), tone: "danger" });
    if (!res.ok && res.code === "attachments_unavailable") toast({ title: t("attachmentsUnavailable"), tone: "danger" });
  };

  return (
    <div className="flex flex-col bg-canvas" style={{ height: "calc(100dvh - var(--bottom-inset))" }}>
      <ChatHeader
        detail={detail}
        typing={chat.peerTyping}
        callsEnabled={CALLS_ENABLED}
        onCall={(type) => calls.start(type, conversationId)}
        onMore={() => setSafetyOpen(true)}
      />

      {chat.status === "loading" ? (
        <div className="flex-1 space-y-3 px-gutter py-4" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className={cn("h-10 rounded-card", i % 2 ? "ml-auto w-2/3" : "w-1/2")} />
          ))}
        </div>
      ) : chat.status === "error" ? (
        <div className="flex flex-1 items-center justify-center px-gutter">
          <ErrorState onRetry={() => void chat.load()} />
        </div>
      ) : (
        <MessageList
          messages={chat.messages}
          viewerId={viewerId}
          peerLastReadAt={detail?.peer_last_read_at ?? null}
          peerTyping={chat.peerTyping}
          hasMore={chat.hasMore}
          loadingOlder={chat.loadingOlder}
          onLoadOlder={() => void chat.loadOlder()}
          onRetry={chat.retry}
        />
      )}

      {blocked ? (
        <div className="flex items-center gap-3 border-t border-subtle bg-surface px-gutter py-3 pb-safe-b">
          <Ban className="h-5 w-5 shrink-0 text-muted" aria-hidden />
          <p className="flex-1 text-sm text-muted">{detail?.blocked_by_me ? t("youBlocked") : t("cannotReply")}</p>
          {detail?.blocked_by_me ? (
            <Button size="sm" variant="secondary" onClick={() => setSafetyOpen(true)}>
              {t("manage")}
            </Button>
          ) : null}
        </div>
      ) : chat.status === "ready" ? (
        <Composer onSend={onSend} onTyping={chat.pingTyping} maxLength={limits.maxBody} maxImageMb={limits.maxImageMb} />
      ) : null}

      {detail ? (
        <ChatSafetySheet
          open={safetyOpen}
          onOpenChange={setSafetyOpen}
          conversationId={conversationId}
          detail={detail}
          onBlockedChange={(b) => chat.setDetail({ ...detail, blocked_by_me: b })}
        />
      ) : null}

      {calls.active ? (
        <ActiveCallOverlay
          authToken={calls.active.authToken}
          callType={calls.active.callType}
          onDisconnect={calls.end}
        />
      ) : null}
      {calls.incoming ? (
        <IncomingCallDialog
          callerName={peerName(
            { user_id: calls.incoming.caller.id, ...calls.incoming.caller },
            t("unknownUser"),
          )}
          callerAvatar={calls.incoming.caller.avatar_url || undefined}
          callType={calls.incoming.call_type}
          onAccept={calls.accept}
          onReject={calls.decline}
        />
      ) : null}
    </div>
  );
}
