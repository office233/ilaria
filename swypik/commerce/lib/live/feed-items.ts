/**
 * Carduri Live pentru feed-ul Home (integrate de agentul de feed):
 *   const items = await getLiveFeedItems({ limit: 3 });
 * Fiecare item are `kind: 'live'` și duce la `/live/<id>`. Doar streamurile
 * confirmate live de serverul media (status 'live') apar aici.
 */
import { listLiveStreams, type LiveStreamPublic } from "./queries";

export type LiveFeedItem = {
  kind: "live";
  id: string;
  href: string;
  title: string;
  viewerCount: number;
  startedAt: string | null;
  creator: {
    id: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  };
};

export function toLiveFeedItem(s: LiveStreamPublic): LiveFeedItem {
  return {
    kind: "live",
    id: s.id,
    href: `/live/${s.id}`,
    title: s.title,
    viewerCount: Number(s.viewer_count) || 0,
    startedAt: s.started_at,
    creator: {
      id: s.creator_id,
      username: s.username,
      displayName: s.display_name,
      avatarUrl: s.avatar_url,
    },
  };
}

export async function getLiveFeedItems(opts: { limit?: number } = {}): Promise<LiveFeedItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
  const rows = await listLiveStreams("live", limit);
  return rows.map(toLiveFeedItem);
}
