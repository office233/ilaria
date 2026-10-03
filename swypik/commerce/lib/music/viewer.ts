import { getViewerUnlocks } from "./repository";
import type { MusicViewer } from "./types";

/** Anonim ⇒ seturi goale (fără interogare DB). */
export async function buildMusicViewer(userId: string | null, isAdmin: boolean): Promise<MusicViewer> {
    if (!userId) return { userId: null, isAdmin: false, unlockedTrackIds: new Set(), unlockedAlbumIds: new Set() };
    const unlocks = await getViewerUnlocks(userId);
    return { userId, isAdmin, unlockedTrackIds: unlocks.trackIds, unlockedAlbumIds: unlocks.albumIds };
}
