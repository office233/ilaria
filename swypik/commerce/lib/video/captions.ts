/**
 * Subtitrări pentru clipuri: generare speech-to-text din `audio.m4a` (scos de
 * worker lângă HLS, mono 16 kHz — mic, sub limita Whisper de 25MB), editare de
 * către creator și servire WebVTT.
 *
 * Calea veche trimitea playlistul .m3u8 la Whisper (nu e audio) → mereu gol.
 * Audio-ul se citește direct din bucket (fără fetch pe URL-uri → fără SSRF).
 */
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { dbQuery } from "@/lib/db";
import { transcribe, type CaptionSegment } from "@/lib/ai/transcribe";
import { segmentsToText } from "@/lib/ai/translate";
import { getS3Client, getVideoStorageBucket } from "@/lib/storage/video-storage";
import { UploadInputError } from "@/lib/video/upload-session";

export type CaptionTrack = { lang: string; text: string; segments: CaptionSegment[]; is_auto: boolean };

export function audioObjectKey(videoId: string): string {
  return `videos/hls/${videoId}/audio.m4a`;
}

function vttTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(rest, 3)}`;
}

/** WebVTT din segmente (ordonate, fără cue-uri goale sau inversate). */
export function segmentsToVtt(segments: CaptionSegment[]): string {
  const cues = segments
    .filter((s) => s.text.trim() && s.end > s.start)
    .sort((a, b) => a.start - b.start)
    .map((s, i) => `${i + 1}\n${vttTime(s.start)} --> ${vttTime(s.end)}\n${s.text.trim().replace(/-->/g, "→")}`);
  return `WEBVTT\n\n${cues.join("\n\n")}${cues.length ? "\n" : ""}`;
}

/** Normalizează segmentele trimise de editor: ordonate, fără suprapuneri inverse. */
export function normalizeSegments(segments: CaptionSegment[]): CaptionSegment[] {
  return segments
    .map((s) => ({ start: Math.max(0, s.start), end: Math.max(0, s.end), text: s.text.replace(/\s+/g, " ").trim() }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
}

export async function listCaptionTracks(videoId: string): Promise<CaptionTrack[]> {
  const { rows } = await dbQuery<CaptionTrack>(
    `SELECT lang, text, COALESCE(segments, '[]'::jsonb) AS segments, is_auto
       FROM video_captions WHERE video_id = $1 ORDER BY lang`,
    [videoId],
  );
  return rows;
}

/** Limita fișierului trimis la speech-to-text (Whisper acceptă max ~25 MB). */
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

async function readAudio(videoId: string): Promise<Buffer> {
  let out;
  try {
    out = await getS3Client().send(new GetObjectCommand({ Bucket: getVideoStorageBucket(), Key: audioObjectKey(videoId) }));
  } catch {
    throw new UploadInputError("no audio track", "no_audio", 409);
  }
  if ((out.ContentLength ?? 0) > MAX_AUDIO_BYTES) {
    throw new UploadInputError("audio too large", "captions_unavailable", 413);
  }
  try {
    const bytes = await out.Body?.transformToByteArray();
    if (!bytes || bytes.length === 0) throw new Error("empty");
    return Buffer.from(bytes);
  } catch {
    throw new UploadInputError("no audio track", "no_audio", 409);
  }
}

/** Generează subtitrarea în limba vorbită; nu suprascrie un text editat de creator. */
export async function generateCaptions(videoId: string, lang: string): Promise<CaptionTrack> {
  const existing = (await listCaptionTracks(videoId)).find((t) => t.lang === lang);
  if (existing && !existing.is_auto) return existing;
  const audio = await readAudio(videoId);
  const result = await transcribe(audio, lang, "audio.m4a");
  if (!result.text || result.segments.length === 0) {
    throw new UploadInputError("speech-to-text unavailable", "captions_unavailable", 503);
  }
  await dbQuery(
    `INSERT INTO video_captions (video_id, lang, text, segments, is_auto, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, true, NOW())
     ON CONFLICT (video_id, lang) DO UPDATE
       SET text = EXCLUDED.text, segments = EXCLUDED.segments, is_auto = true, updated_at = NOW()
       WHERE video_captions.is_auto = true`,
    [videoId, lang, result.text, JSON.stringify(result.segments)],
  );
  return { lang, text: result.text, segments: result.segments, is_auto: true };
}

export async function saveCaptions(
  videoId: string,
  lang: string,
  segments: CaptionSegment[],
  userId: string,
): Promise<CaptionTrack> {
  const clean = normalizeSegments(segments);
  const text = segmentsToText(clean);
  await dbQuery(
    `INSERT INTO video_captions (video_id, lang, text, segments, is_auto, updated_at, edited_by_user_id)
     VALUES ($1, $2, $3, $4::jsonb, false, NOW(), $5)
     ON CONFLICT (video_id, lang) DO UPDATE
       SET text = EXCLUDED.text, segments = EXCLUDED.segments, is_auto = false,
           updated_at = NOW(), edited_by_user_id = EXCLUDED.edited_by_user_id`,
    [videoId, lang, text, JSON.stringify(clean), userId],
  );
  return { lang, text, segments: clean, is_auto: false };
}
