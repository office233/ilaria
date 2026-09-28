"use client";

import { useCallback, useEffect, useState } from "react";
import { SquarePen } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconButton } from "@/components/ui/IconButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { ConversationList, type ConversationsState } from "@/components/messenger/inbox/ConversationList";
import { NewMessageSheet } from "@/components/messenger/inbox/NewMessageSheet";
import { NotificationList } from "@/components/messenger/inbox/NotificationList";
import type { ConversationSummary } from "@/components/messenger/types";
import { useNotifications } from "@/lib/notifications/use-notifications";

export type InboxTab = "messages" | "notifications";

function CountBadge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-xs font-semibold text-brand-fg">
      {n > 99 ? "99+" : n}
    </span>
  );
}

/** Inbox (tab-ul BottomNav): Mesaje + Notificări într-o singură pagină. */
export default function InboxClient({ viewerId, initialTab }: { viewerId: string; initialTab: InboxTab }) {
  const t = useTranslations("dm.inbox");
  const [tab, setTab] = useState<InboxTab>(initialTab);
  const [convs, setConvs] = useState<ConversationsState>({ status: "loading" });
  const [newOpen, setNewOpen] = useState(false);
  const notifications = useNotifications();

  const loadConversations = useCallback(async () => {
    setConvs({ status: "loading" });
    try {
      const res = await fetch("/api/dm/conversations?limit=50", { cache: "no-store" });
      if (res.status === 410) return setConvs({ status: "disabled" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { conversations?: ConversationSummary[] };
      setConvs({ status: "ready", items: data.conversations ?? [] });
    } catch {
      setConvs({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  const changeTab = (value: string) => {
    const next: InboxTab = value === "notifications" ? "notifications" : "messages";
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  };

  const unreadChats = convs.status === "ready" ? convs.items.filter((c) => c.unread_count > 0).length : 0;
  const canCompose = convs.status !== "disabled";

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader
        title={t("title")}
        actions={
          canCompose ? (
            <IconButton label={t("newMessage")} onClick={() => setNewOpen(true)}>
              <SquarePen aria-hidden />
            </IconButton>
          ) : null
        }
      />
      <Tabs value={tab} onValueChange={changeTab} className="mx-auto max-w-2xl">
        <TabsList aria-label={t("tabsLabel")}>
          <TabsTrigger value="messages">
            {t("tabMessages")}
            <CountBadge n={unreadChats} />
          </TabsTrigger>
          <TabsTrigger value="notifications">
            {t("tabNotifications")}
            <CountBadge n={notifications.unread} />
          </TabsTrigger>
        </TabsList>
        <TabsContent value="messages">
          <ConversationList
            state={convs}
            viewerId={viewerId}
            onRetry={() => void loadConversations()}
            onNewMessage={() => setNewOpen(true)}
          />
        </TabsContent>
        <TabsContent value="notifications">
          <NotificationList state={notifications} />
        </TabsContent>
      </Tabs>
      <NewMessageSheet open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
