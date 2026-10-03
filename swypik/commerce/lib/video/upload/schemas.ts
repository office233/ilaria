/** Schemele zod ale fluxului de upload/publicare video (limitele vin din lib/video/limits). */
import { z } from "zod";
import { VIDEO_LIMITS } from "@/lib/video/limits";
import { SoundMixSchema } from "@/lib/video/sound-mix";

export const CreateUploadSessionSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().max(128).optional().default(""),
  sizeBytes: z.coerce.number().finite().positive().max(VIDEO_LIMITS.maxBytes),
  title: z.string().trim().max(VIDEO_LIMITS.titleMaxChars).optional(),
  description: z.string().trim().max(VIDEO_LIMITS.descriptionMaxChars).optional(),
  source: z.enum(["gallery", "camera"]).optional(),
  audioTrackId: z.coerce.number().int().positive().optional(),
});

export const SignPartsSchema = z.object({
  partNumbers: z
    .array(z.number().int().min(1).max(VIDEO_LIMITS.maxParts))
    .min(1)
    .max(VIDEO_LIMITS.maxPartUrlsPerRequest),
});

const optionalMs = z.number().int().min(0).max(24 * 60 * 60 * 1000).nullable().optional();

export const CompleteUploadSchema = z.object({
  trim: z.object({ startMs: optionalMs, endMs: optionalMs }).optional(),
});

const tag = z.string().trim().min(1).max(VIDEO_LIMITS.hashtagMaxChars);

/** PATCH /api/creator/videos/[id] — detalii + intenția de publicare. */
export const VideoDetailsSchema = z
  .object({
    title: z.string().trim().max(VIDEO_LIMITS.titleMaxChars).optional(),
    description: z.string().trim().max(VIDEO_LIMITS.descriptionMaxChars).nullable().optional(),
    tags: z.array(tag).max(VIDEO_LIMITS.hashtagsMax).optional(),
    allow_comments: z.boolean().optional(),
    allow_duet: z.boolean().optional(),
    allow_stitch: z.boolean().optional(),
    audio_track_id: z.number().int().positive().nullable().optional(),
    /** Cum e mixat sunetul ales (volum, audio original, buclă, start). Vezi lib/video/sound-mix.ts. */
    sound_mix: SoundMixSchema.nullable().optional(),
    product_id: z.string().trim().min(1).max(128).nullable().optional(),
    product_overlay_ms: z.number().int().min(0).max(VIDEO_LIMITS.maxDurationMs).optional(),
    /** Misiunea (uuid) la care e înscris clipul; null = retrage. Validare uuid + reguli în rută (invalid_mission_id). */
    missionId: z.string().max(64).nullable().optional(),
    captions_enabled: z.boolean().optional(),
    /** draft = salvează; public = publică acum; scheduled = programează; unlisted/private = fără feed. */
    publish: z.enum(["draft", "public", "scheduled", "unlisted", "private"]).optional(),
    scheduled_publish_at: z.string().datetime({ offset: true }).nullable().optional(),
    ai_hook_selected: z.string().max(500).nullable().optional(),
    ai_caption_used: z.boolean().optional(),
    collection_hint: z.string().max(120).nullable().optional(),
  })
  .strict();

export type VideoDetailsInput = z.infer<typeof VideoDetailsSchema>;

export const CaptionSegmentSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string().max(1000),
});

export const SaveCaptionsSchema = z.object({
  lang: z.string().trim().regex(/^[a-z]{2}$/),
  segments: z.array(CaptionSegmentSchema).max(2000),
});
