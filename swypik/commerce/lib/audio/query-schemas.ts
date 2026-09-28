import { z } from "zod";

const AUDIO_SOURCES = ["all", "radio", "audius", "jamendo", "podcast"] as const;

/** Query params for GET /api/audio/feed. */
export const AudioFeedQuerySchema = z.object({
  tab: z.enum(AUDIO_SOURCES).default("all"),
});

/** Query params for GET /api/audio/search. */
export const AudioSearchQuerySchema = z.object({
  q: z.string().trim().max(100).optional().default(""),
  source: z.enum(AUDIO_SOURCES).default("all"),
});
