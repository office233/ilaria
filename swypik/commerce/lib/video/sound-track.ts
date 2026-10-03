/** Validarea pe server a piesei alese pentru un clip (vezi lib/video/sound-mix.ts). */
import { dbQuery } from "@/lib/db";
import { UploadInputError } from "@/lib/video/upload-session";

/** Piesa poate fi folosită în reels: există, e activă și licențiată comercial. */
export async function isMixableTrack(trackId: number): Promise<boolean> {
  const { rows } = await dbQuery<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM audio_tracks
        WHERE id = $1 AND is_active = true AND licensed_for_commercial = true
     ) AS ok`,
    [trackId],
  );
  return Boolean(rows[0]?.ok);
}

/** 422 `invalid_audio_track` în loc de FK 23503 → 500 (sau o piesă nelicențiată acceptată). */
export async function assertMixableTrack(trackId: number | null | undefined): Promise<void> {
  if (trackId === null || trackId === undefined) return;
  if (!(await isMixableTrack(trackId))) {
    throw new UploadInputError("audio track not available", "invalid_audio_track", 422);
  }
}
