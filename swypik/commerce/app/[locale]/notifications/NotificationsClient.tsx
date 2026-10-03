"use client";

import { Bell, CheckCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { NotificationRow } from "@/components/notifications/NotificationRow";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { useNotifications } from "@/lib/notifications/use-notifications";

export default function NotificationsClient() {
  const t = useTranslations("notificationsPage");
  const ts = useTranslations("social.notifications");
  const { items, unread, loading, marking, markAll, markOne, hasMore, loadingMore, loadMore } = useNotifications(30);

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader
        title={t("title")}
        actions={
          <Button variant="ghost" size="sm" onClick={markAll} disabled={marking || unread === 0}>
            <CheckCheck aria-hidden className="h-4 w-4" />
            <span className="sr-only sm:not-sr-only">{t("markAllRead")}</span>
          </Button>
        }
      />
      <main className="mx-auto max-w-lg py-2">
        {loading ? (
          <div className="flex flex-col gap-4 px-gutter py-3" aria-busy="true" aria-label={t("loading")}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={Bell} title={t("emptyTitle")} description={t("emptyBody")} className="py-16" />
        ) : (
          <>
            <ul className="divide-y divide-subtle">
              {items.map((n) => (
                <NotificationRow key={n.id} n={n} onOpen={(row) => !row.read_at && void markOne(row.id)} />
              ))}
            </ul>
            {hasMore ? (
              <div className="flex justify-center py-4">
                <Button variant="secondary" size="sm" loading={loadingMore} onClick={() => void loadMore()}>
                  {ts("loadMore")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
