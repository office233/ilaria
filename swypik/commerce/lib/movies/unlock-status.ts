import { dbQuery } from "@/lib/db";

export type UnlockStatus = "paid" | "pending" | "none";

/**
 * Starea deblocării pentru un user: sezonul plătit acoperă orice episod.
 * `episodeId === null` = întrebăm doar de sezon.
 */
export async function getUnlockStatus(userId: string, seriesId: string, episodeId: string | null): Promise<UnlockStatus> {
    const { rows } = await dbQuery<{ episode_id: string | null; status: string }>(
        `SELECT episode_id, status FROM movie_unlocks
          WHERE user_id = $1 AND series_id = $2 AND (episode_id IS NULL OR episode_id = $3)`,
        [userId, seriesId, episodeId],
    );
    return unlockStatusFromRows(rows, episodeId);
}

/** Pură: decizia din rândurile găsite. */
export function unlockStatusFromRows(rows: Array<{ episode_id: string | null; status: string }>, episodeId: string | null): UnlockStatus {
    const relevant = rows.filter((r) => r.episode_id === null || r.episode_id === episodeId);
    if (relevant.some((r) => r.status === "paid")) return "paid";
    return relevant.some((r) => r.status === "pending") ? "pending" : "none";
}
