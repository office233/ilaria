/** Formularul „Detalii” (pur): valori implicite, hashtag-uri, corpul PATCH. */
import type { DetailsDraft } from "@/lib/upload/draft-store";
import type { VideoDetailsInput } from "@/lib/video/upload/schemas";
import { VIDEO_LIMITS } from "@/lib/video/limits";
import { DEFAULT_SOUND_MIX } from "@/lib/video/sound-mix";

export const EMPTY_DETAILS: DetailsDraft = {
  title: "",
  description: "",
  productId: null,
  productTitle: null,
  productOverlaySec: 0,
  missionId: null,
  audioTrackId: null,
  audioTrackLabel: null,
  soundVolume: DEFAULT_SOUND_MIX.volume,
  soundOriginalVolume: DEFAULT_SOUND_MIX.original_volume,
  soundKeepOriginal: DEFAULT_SOUND_MIX.keep_original,
  soundLoop: DEFAULT_SOUND_MIX.loop,
  allowComments: true,
  allowDuet: true,
  allowStitch: true,
  captionsEnabled: false,
};

/** #hashtag-uri din descriere (litere Unicode, cifre, _), fără duplicate, max hashtagsMax. */
export function extractHashtags(text: string): string[] {
  const found = text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  const tags: string[] = [];
  for (const raw of found) {
    const tag = raw.slice(1).toLowerCase().slice(0, VIDEO_LIMITS.hashtagMaxChars);
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, VIDEO_LIMITS.hashtagsMax);
}

export type PublishIntent = "draft" | "public" | "scheduled";

/**
 * `missionBaseline` = misiunea deja legată pe server (null pentru un clip nou):
 * `missionId` se trimite doar când alegerea diferă, ca salvarea unui draft să nu
 * reînscrie/retragă clipul fără o schimbare explicită în picker.
 */
export function toVideoPatch(
  d: DetailsDraft,
  intent: PublishIntent,
  scheduledAt?: string,
  missionBaseline: string | null = null,
): VideoDetailsInput {
  const body: VideoDetailsInput = {
    description: d.description.trim(),
    tags: extractHashtags(d.description),
    allow_comments: d.allowComments,
    allow_duet: d.allowDuet,
    allow_stitch: d.allowStitch,
    audio_track_id: d.audioTrackId,
    product_id: d.productId,
    captions_enabled: d.captionsEnabled,
    publish: intent,
  };
  const title = d.title.trim();
  if (title) body.title = title;
  if (d.audioTrackId) {
    body.sound_mix = {
      volume: Math.round(d.soundVolume),
      original_volume: Math.round(d.soundOriginalVolume),
      keep_original: d.soundKeepOriginal,
      loop: d.soundLoop,
    };
  }
  if (d.productId) body.product_overlay_ms = Math.max(0, Math.round(d.productOverlaySec * 1000));
  if (d.missionId !== missionBaseline) body.missionId = d.missionId;
  if (intent === "scheduled" && scheduledAt) body.scheduled_publish_at = scheduledAt;
  return body;
}
