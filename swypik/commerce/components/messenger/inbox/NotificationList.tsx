"use client";

import { Bell, CheckCheck } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListItem } from "@/components/ui/ListItem";
import { Skeleton } from "@/components/ui/Skeleton";
import type { UseNotifications } from "@/lib/notifications/use-notifications";
import { notificationHref } from "@/lib/dm/links";
import { cn } from "@/lib/ui/cn";

/** Tab-ul Notificări din Inbox (starea vine din useNotifications, partajat cu /notifications). */
export function NotificationList({ state }: { state: UseNotifications }) {
  const t = useTranslations("dm.inbox");
  const format = useFormatter();
  const { items, unread, loading, marking, markAll, markOne } = state;

  if (loading) {
    return (
      <div className="space-y-2 px-gutter py-3" aria-busy>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-control" />
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return <EmptyState icon={Bell} title={t("notificationsEmptyTitle")} description={t("notificationsEmptyDescription")} />;
  }

  return (
    <div className="px-gutter py-3">
      <div className="mb-2 flex justify-end">
        <Button size="sm" variant="secondary" loading={marking} disabled={unread === 0} onClick={() => void markAll()}>
          <CheckCheck className="h-4 w-4" aria-hidden />
          {t("markAllRead")}
        </Button>
      </div>
      <ul className="space-y-0.5">
        {items.map((n) => {
          const isUnread = !n.read_at;
          return (
            <li key={n.id}>
              <ListItem
                href={notificationHref(n.action_url)}
                onClick={isUnread ? () => void markOne(n.id) : undefined}
                leading={
                  <span
                    aria-hidden
                    className={cn("h-2.5 w-2.5 shrink-0 rounded-full", isUnread ? "bg-brand" : "bg-transparent")}
                  />
                }
                title={<span className={isUnread ? "font-bold" : "font-medium"}>{n.title}</span>}
                subtitle={n.body || undefined}
                trailing={
                  <time dateTime={n.created_at} className="shrink-0 text-xs text-subtle">
                    {format.relativeTime(new Date(n.created_at))}
                  </time>
                }
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
