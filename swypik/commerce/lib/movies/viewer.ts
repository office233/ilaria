import { getViewerUnlocks } from "./repository";
import type { ViewerContext } from "./types";

export async function buildViewerContext(userId: string | null, isAdmin: boolean, seriesId: string): Promise<ViewerContext> {
    if (!userId) return { userId: null, isAdmin: false, unlockedEpisodeIds: new Set(), hasSeasonUnlock: false };
    const unlocks = await getViewerUnlocks(userId, seriesId);
    return { userId, isAdmin, unlockedEpisodeIds: unlocks.episodeIds, hasSeasonUnlock: unlocks.season };
}
