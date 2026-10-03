import { Radio } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";

type Row = { id: string; title: string; display_name: string | null; username: string | null };

const BADGE_LIMIT = 6;

/**
 * Pastilele „LIVE” de pe /explore: live-urile creatorilor urmăriți (sau cele
 * mai urmărite pentru vizitatori). Doar streamuri confirmate live.
 */
export default async function LiveBadge() {
  const session = await getAuthSession().catch(() => null);
  let rows: Row[] = [];
  try {
    const q = session
      ? await dbQuery<Row>(
          `SELECT ls.id, ls.title, u.display_name, u.username
             FROM live_streams ls
             JOIN follows f ON f.following_user_id::text = ls.creator_id
             LEFT JOIN users u ON u.id::text = ls.creator_id
            WHERE ls.status = 'live' AND f.follower_user_id = $1::uuid
            ORDER BY ls.started_at DESC LIMIT $2`,
          [session.userId, BADGE_LIMIT],
        )
      : await dbQuery<Row>(
          `SELECT ls.id, ls.title, u.display_name, u.username
             FROM live_streams ls
             LEFT JOIN users u ON u.id::text = ls.creator_id
            WHERE ls.status = 'live'
            ORDER BY ls.viewer_count DESC, ls.started_at DESC LIMIT $1`,
          [BADGE_LIMIT],
        );
    rows = q.rows;
  } catch {
    rows = [];
  }
  if (!rows.length) return null;
  const t = await getTranslations("live.badge");
  return (
    <div className="pointer-events-auto absolute left-0 right-0 top-14 z-30 overflow-x-auto px-3">
      <div className="flex gap-2">
        {rows.map((s) => (
          <Link
            key={s.id}
            href={`/live/${s.id}`}
            className="flex min-h-9 items-center gap-2 whitespace-nowrap rounded-full bg-danger px-3 text-xs text-white shadow-elev-2"
          >
            <Radio className="h-3.5 w-3.5 animate-pulse" aria-hidden />
            <span className="font-bold">{t("live")}</span>
            <span className="max-w-[140px] truncate">{s.display_name || s.username || t("creatorFallback")}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
