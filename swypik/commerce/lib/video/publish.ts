/**
 * PATCH /api/creator/videos/[id] — detaliile clipului + intenția de publicare.
 *
 * - `publish: "public"` e permis cât timp clipul se procesează: apare în feed
 *   singur când devine 'ready' (feed-ul cere status='ready').
 * - Publicarea (public/programat/unlisted) rulează moderarea pe textul final.
 * - Editarea titlului/descrierii/hashtag-urilor unui clip deja publicat sau
 *   aprobat re-rulează moderarea (altfel: text curat → aprobat → PATCH cu orice).
 * - Sunetul ales e validat (activ + licențiat) și mixat de worker; schimbarea
 *   lui pe un clip deja procesat pornește re-transcodarea (lib/video/sound-mix.ts).
 * - Produsul etichetat trebuie să fie eligibil pentru feed (altfel ar ascunde clipul).
 * - Programarea cere o dată viitoare.
 */
import { dbQuery, getDb } from "@/lib/db";
import { autoEmbedVideo } from "@/lib/ai/auto-embed";
import type { OwnedVideo } from "@/lib/video/auth";
import { moderateOnPublish, type ModerationDecision } from "@/lib/video/moderation-gate";
import { isFeedEligibleProduct } from "@/lib/video/product-eligibility";
import { notifyFollowersOnce } from "@/lib/video/publish-notify";
import { normalizeSoundMix, soundMixKey } from "@/lib/video/sound-mix";
import { assertMixableTrack } from "@/lib/video/sound-track";
import { reprocessVideo } from "@/lib/video/upload/reprocess";
import { logger } from "@/lib/logger";
import { UploadInputError } from "@/lib/video/upload-session";
import type { VideoDetailsInput } from "@/lib/video/upload/schemas";

const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_SCHEDULE_AHEAD_MS = 60 * 1000;

export type DetailsUpdate = { sets: string[]; values: unknown[]; publishing: boolean };

/** Construiește UPDATE-ul (pur, testabil). `$1` e rezervat pentru id-ul clipului. */
export function buildDetailsUpdate(input: VideoDetailsInput, video: OwnedVideo, now = Date.now()): DetailsUpdate {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (clause: (n: number) => string, value: unknown) => {
    values.push(value);
    sets.push(clause(values.length + 1));
  };

  if (input.title !== undefined && input.title) push((n) => `title = $${n}`, input.title);
  if (input.description !== undefined) push((n) => `description = $${n}`, input.description ?? "");
  if (input.tags !== undefined) {
    const tags = Array.from(new Set(input.tags.map((t) => t.replace(/^#/, "").toLowerCase()).filter(Boolean)));
    push((n) => `tags = $${n}::text[]`, tags);
  }
  if (input.allow_comments !== undefined) push((n) => `allow_comments = $${n}`, input.allow_comments);
  if (input.allow_duet !== undefined) push((n) => `allow_duet = $${n}`, input.allow_duet);
  if (input.allow_stitch !== undefined) push((n) => `allow_stitch = $${n}`, input.allow_stitch);
  if (input.audio_track_id !== undefined) push((n) => `audio_track_id = $${n}`, input.audio_track_id);
  if (input.product_id === null) sets.push(`product_refs = '[]'::jsonb`);
  else if (input.product_id) {
    push((n) => `product_refs = jsonb_build_array(jsonb_build_object('product_id', $${n}::text, 'source', 'creator_upload'))`, input.product_id);
  }
  const meta: Record<string, unknown> = {};
  if (input.captions_enabled !== undefined) meta.captions_enabled = input.captions_enabled;
  if (input.collection_hint !== undefined) meta.collection_hint = input.collection_hint;
  if (input.sound_mix !== undefined) meta.sound_mix = input.sound_mix === null ? null : normalizeSoundMix(input.sound_mix);
  if (Object.keys(meta).length) push((n) => `metadata = metadata || $${n}::jsonb`, JSON.stringify(meta));
  if (input.ai_hook_selected !== undefined) push((n) => `ai_hook_selected = $${n}`, input.ai_hook_selected);
  if (input.ai_caption_used !== undefined) push((n) => `ai_caption_used = $${n}`, input.ai_caption_used);

  const intent = input.publish;
  if (intent) {
    if (intent !== "draft" && (video.status === "uploading" || video.status === "failed")) {
      throw new UploadInputError("video not uploaded", video.status === "failed" ? "video_failed" : "not_uploaded", 409);
    }
    if (intent === "scheduled") {
      const at = input.scheduled_publish_at ? Date.parse(input.scheduled_publish_at) : NaN;
      if (!Number.isFinite(at) || at < now + MIN_SCHEDULE_AHEAD_MS || at > now + MAX_SCHEDULE_AHEAD_MS) {
        throw new UploadInputError("schedule must be in the future", "invalid_schedule");
      }
      push((n) => `scheduled_publish_at = $${n}::timestamptz`, new Date(at).toISOString());
      sets.push(`visibility = 'draft'`, `is_draft = false`);
    } else {
      sets.push(`scheduled_publish_at = NULL`);
      push((n) => `visibility = $${n}`, intent === "public" ? "public" : intent);
      sets.push(`is_draft = ${intent === "draft" ? "true" : "false"}`);
      if (intent === "public") sets.push(`published_at = COALESCE(published_at, NOW())`);
    }
  }

  if (sets.length === 0) throw new UploadInputError("no fields", "no_fields");
  sets.push("updated_at = NOW()");
  return { sets, values, publishing: intent === "public" || intent === "scheduled" || intent === "unlisted" };
}

export type ApplyResult = {
  videoId: string;
  status: string;
  visibility: string;
  moderationStatus: ModerationDecision | string;
  /** Clipul se vede acum în feed (ready + public + aprobat). */
  liveNow: boolean;
  /** Sunetul nou se mixează (re-transcodare pornită) / nu se poate mixa (fără sursă păstrată). */
  soundMix?: "remixing" | "unavailable";
};

function normTags(tags: readonly string[] | null | undefined): string {
  return Array.from(new Set((tags ?? []).map((t) => t.replace(/^#/, "").toLowerCase()).filter(Boolean)))
    .sort()
    .join(" ");
}

/** Textul public al clipului (titlu/descriere/hashtag-uri) se schimbă prin acest PATCH. Pur. */
export function textChanged(input: VideoDetailsInput, video: OwnedVideo): boolean {
  if (input.title !== undefined && input.title && input.title !== (video.title ?? "")) return true;
  if (input.description !== undefined && (input.description ?? "") !== (video.description ?? "")) return true;
  if (input.tags !== undefined && normTags(input.tags) !== normTags(video.tags)) return true;
  return false;
}

/** Clipul e (sau a fost) vizibil public: orice text nou trebuie moderat din nou. Pur. */
export function needsRemoderation(input: VideoDetailsInput, video: OwnedVideo): boolean {
  if (!textChanged(input, video)) return false;
  return video.visibility !== "draft" || video.moderation_status === "approved" || Boolean(video.published_at);
}

type FreshRow = {
  status: string;
  visibility: string;
  moderation_status: string;
  title: string;
  description: string | null;
  tags: string[] | null;
  audio_track_id?: number | string | null;
  sound_mix?: unknown;
  sound_mixed_key?: string | null;
  track_mixable?: boolean | null;
};

export async function applyVideoDetails(video: OwnedVideo, input: VideoDetailsInput): Promise<ApplyResult> {
  if (input.product_id && !(await isFeedEligibleProduct(input.product_id))) {
    throw new UploadInputError("product not eligible", "product_not_eligible", 422);
  }
  // Doar o piesă NOUĂ e validată: una deja legată și dezactivată între timp nu blochează salvarea.
  const currentTrack = video.audio_track_id == null ? null : Number(video.audio_track_id);
  if (input.audio_track_id != null && input.audio_track_id !== currentTrack) {
    await assertMixableTrack(input.audio_track_id);
  }
  const update = buildDetailsUpdate(input, video);

  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE videos SET ${update.sets.join(", ")} WHERE id = $1`, [video.id, ...update.values]);
    if (input.product_id !== undefined) {
      await client.query(`DELETE FROM video_product_links WHERE video_id = $1 AND placement = 'overlay'`, [video.id]);
      if (input.product_id) {
        await client.query(
          `INSERT INTO video_product_links (video_id, product_id, placement, start_ms, end_ms, sort_order, metadata)
           VALUES ($1, $2::uuid, 'overlay', $3, NULL, 0, '{}'::jsonb) ON CONFLICT DO NOTHING`,
          [video.id, input.product_id, input.product_overlay_ms ?? 0],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const { rows } = await dbQuery<FreshRow>(
    `SELECT status, visibility, moderation_status, title, description, tags,
            audio_track_id, metadata->'sound_mix' AS sound_mix, metadata->>'sound_mixed_key' AS sound_mixed_key,
            EXISTS (SELECT 1 FROM audio_tracks at WHERE at.id = videos.audio_track_id
                     AND at.is_active = true AND at.licensed_for_commercial = true) AS track_mixable
       FROM videos WHERE id = $1`,
    [video.id],
  );
  const fresh = rows[0];
  let moderation: string = fresh.moderation_status;
  if (update.publishing || needsRemoderation(input, video)) {
    moderation = await moderateOnPublish({
      videoId: video.id,
      creatorId: video.creator_id,
      currentStatus: fresh.moderation_status,
      title: fresh.title,
      description: fresh.description ?? "",
      tags: fresh.tags ?? [],
    });
    await dbQuery(`UPDATE videos SET moderation_status = $2, updated_at = NOW() WHERE id = $1`, [video.id, moderation]);
  }
  if (input.title !== undefined || input.description !== undefined) {
    autoEmbedVideo(video.id, fresh.title, fresh.description ?? "");
  }
  const soundMix =
    input.audio_track_id !== undefined || input.sound_mix !== undefined ? await remixIfNeeded(video.id, fresh) : undefined;
  const status = soundMix === "remixing" ? "processing" : fresh.status;
  const liveNow = status === "ready" && fresh.visibility === "public" && moderation === "approved";
  if (liveNow) await notifyFollowersOnce(video.id);
  return {
    videoId: video.id,
    status,
    visibility: fresh.visibility,
    moderationStatus: moderation,
    liveNow,
    ...(soundMix ? { soundMix } : {}),
  };
}

/** Cheia dorită a mixului (doar piese mixabile) — aceeași regulă ca workerul. Pur. */
export function desiredSoundKey(fresh: Pick<FreshRow, "audio_track_id" | "sound_mix" | "track_mixable">): string {
  return fresh.track_mixable ? soundMixKey(fresh.audio_track_id ?? null, fresh.sound_mix) : "none";
}

/**
 * Clip deja procesat cu alt mix decât cel cerut → re-transcodare din sursa
 * păstrată. În timpul procesării workerul recitește setările la final
 * (video_worker/sound_mix.py), deci nu e nevoie de un job nou.
 */
async function remixIfNeeded(videoId: string, fresh: FreshRow): Promise<ApplyResult["soundMix"]> {
  if (fresh.status !== "ready") return undefined;
  if (desiredSoundKey(fresh) === (fresh.sound_mixed_key || "none")) return undefined;
  try {
    await reprocessVideo(videoId, { reencode: true });
    return "remixing";
  } catch (err) {
    // Clipuri importate fără sursă păstrată: detaliile rămân salvate, sunetul nu se poate mixa.
    logger.warn({ err, videoId }, "[publish] sound remix not possible");
    return "unavailable";
  }
}
