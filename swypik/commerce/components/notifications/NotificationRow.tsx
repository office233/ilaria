"use client";

import { AtSign, Bell, Heart, MessageCircle, Reply, UserPlus, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/Avatar";
import { Link } from "@/lib/i18n/navigation";
import type { Notification } from "@/lib/notifications/use-notifications";
import { relativeTime } from "@/lib/social/format";
import { cn } from "@/lib/ui/cn";

const ICONS: Record<string, LucideIcon> = {
  follow: UserPlus,
  like: Heart,
  comment: MessageCircle,
  reply: Reply,
  mention: AtSign,
};

/** Un rând de notificare: avatarul actorului + iconița tipului, titlu, extras, timp. */
export function NotificationRow({ n, onOpen }: { n: Notification; onOpen: (n: Notification) => void }) {
  const t = useTranslations("social.notifications");
  const Icon = ICONS[n.notification_type] ?? Bell;
  const unread = !n.read_at;
  const rel = relativeTime(n.created_at);
  const time = rel.unit === "now" ? t("time.now") : t(`time.${rel.unit}`, { count: rel.value });
  const actorName = n.actor_display_name || (n.actor_username ? `@${n.actor_username}` : null);

  return (
    <li>
      <Link
        href={n.action_url || "/notifications"}
        onClick={() => onOpen(n)}
        className={cn(
          "flex min-h-16 items-start gap-3 px-gutter py-3 transition-colors hover:bg-surface-2",
          unread && "bg-brand-soft/40",
        )}
      >
        <span className="relative shrink-0">
          {actorName ? (
            <Avatar src={n.actor_avatar_url} name={actorName} />
          ) : (
            <span className="grid h-10 w-10 place-items-center rounded-full bg-surface-2 text-muted">
              <Bell aria-hidden className="h-5 w-5" />
            </span>
          )}
          <span className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full bg-brand text-brand-fg ring-2 ring-canvas">
            <Icon aria-hidden className="h-3 w-3" />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block text-sm text-fg", unread ? "font-semibold" : "font-medium")}>{n.title}</span>
          {n.body ? <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{n.body}</span> : null}
          <span className="mt-1 block text-xs text-subtle">{time}</span>
        </span>
        {unread ? <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-brand" aria-label={t("unread")} /> : null}
      </Link>
    </li>
  );
}
