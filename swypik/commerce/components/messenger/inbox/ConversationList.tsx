"use client";

import { useMemo, useState } from "react";
import { MessageCircle, Search } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Input } from "@/components/ui/Input";
import { ListItem } from "@/components/ui/ListItem";
import { Skeleton } from "@/components/ui/Skeleton";
import { conversationPath } from "@/lib/dm/links";
import { peerName, type ConversationSummary } from "../types";

export type ConversationsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "disabled" }
  | { status: "ready"; items: ConversationSummary[] };

type Props = {
  state: ConversationsState;
  viewerId: string | null;
  onRetry: () => void;
  onNewMessage: () => void;
};

/** Lista de conversații din Inbox: căutare locală, previzualizare, necitite. */
export function ConversationList({ state, viewerId, onRetry, onNewMessage }: Props) {
  const t = useTranslations("dm.inbox");
  const format = useFormatter();
  const [query, setQuery] = useState("");

  const items = useMemo(() => {
    if (state.status !== "ready") return [];
    const q = query.trim().toLowerCase();
    if (!q) return state.items;
    return state.items.filter((c) =>
      [c.peer?.display_name, c.peer?.username].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [state, query]);

  if (state.status === "loading") {
    return (
      <div className="space-y-2 px-gutter py-3" aria-busy>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (state.status === "error") return <ErrorState className="py-10" onRetry={onRetry} />;
  if (state.status === "disabled") {
    return <EmptyState icon={MessageCircle} title={t("disabledTitle")} description={t("disabledDescription")} />;
  }
  if (state.items.length === 0) {
    return (
      <EmptyState
        icon={MessageCircle}
        title={t("emptyTitle")}
        description={t("emptyDescription")}
        action={<Button onClick={onNewMessage}>{t("newMessage")}</Button>}
      />
    );
  }

  const preview = (c: ConversationSummary) => {
    const lm = c.last_message;
    if (!lm) return t("newConversation");
    const text = lm.body || (lm.has_media ? t("photo") : "");
    return lm.sender_id === viewerId ? t("you", { text }) : text;
  };

  return (
    <div className="px-gutter py-3">
      <label className="relative mb-2 block">
        <span className="sr-only">{t("searchLabel")}</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="pl-9"
          type="search"
        />
      </label>
      {items.length === 0 ? <p className="py-6 text-center text-sm text-muted">{t("noMatches")}</p> : null}
      <ul className="space-y-0.5">
        {items.map((c) => {
          const name = peerName(c.peer, t("unknownUser"));
          const when = c.last_message?.created_at || c.last_message_at || c.created_at;
          return (
            <li key={c.id}>
              <ListItem
                href={conversationPath(c.id)}
                leading={<Avatar src={c.peer?.avatar_url} name={name} />}
                title={<span className={c.unread_count > 0 ? "font-bold" : undefined}>{name}</span>}
                subtitle={preview(c)}
                trailing={
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <time dateTime={when} className="text-xs text-subtle">
                      {format.relativeTime(new Date(when))}
                    </time>
                    {c.unread_count > 0 ? (
                      <Badge tone="solid" size="sm" aria-label={t("unreadCount", { count: c.unread_count })}>
                        {c.unread_count > 99 ? "99+" : c.unread_count}
                      </Badge>
                    ) : null}
                  </span>
                }
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
