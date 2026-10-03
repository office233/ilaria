import { Eye } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Link } from "@/lib/i18n/navigation";
import type { LiveFeedItem } from "@/lib/live/feed-items";

type Props = {
  item: LiveFeedItem;
  liveLabel: string;
  subtitle?: string;
  viewersLabel: string;
};

/** Card 9:16 pentru grila /live (fundal: avatarul creatorului, estompat). */
export function LiveCard({ item, liveLabel, subtitle, viewersLabel }: Props) {
  const name = item.creator.displayName || (item.creator.username ? `@${item.creator.username}` : "");
  return (
    <Link
      href={item.href}
      className="relative block aspect-[9/16] overflow-hidden rounded-card bg-surface-2 focus-visible:outline-none focus-visible:ring-2"
    >
      {item.creator.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- avatar extern, folosit doar ca fundal
        <img src={item.creator.avatarUrl} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-sm" />
      ) : null}
      <div className="absolute inset-x-2 top-2 flex items-center gap-1.5">
        <Badge tone="danger" className="bg-danger text-white">{liveLabel}</Badge>
        {subtitle ? null : (
          <Badge tone="overlay" aria-label={viewersLabel}>
            <Eye className="h-3.5 w-3.5" aria-hidden />
            {item.viewerCount}
          </Badge>
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 space-y-1.5 bg-gradient-to-t from-black/75 to-transparent p-2.5 pt-10 text-white">
        <p className="line-clamp-2 text-sm font-semibold">{item.title}</p>
        <span className="flex items-center gap-1.5 text-xs text-white/80">
          <Avatar src={item.creator.avatarUrl} name={name} size="xs" />
          <span className="truncate">{subtitle ?? name}</span>
        </span>
      </div>
    </Link>
  );
}
