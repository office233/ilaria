import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { videoMissionFieldSchema } from "@/lib/missions/schemas";
import { applyVideoMissionField } from "@/lib/missions/video-field";
import { loadOwnedVideo } from "@/lib/video/auth";
import { applyVideoDetails } from "@/lib/video/publish";
import { errorResponse, guardAuthor, jsonError, readJson, validId } from "@/lib/video/upload/http";
import { VideoDetailsSchema } from "@/lib/video/upload/schemas";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Clipul propriu (draft, programat, publicat) — folosit la reluarea unui draft în wizard. */
export async function GET(_req: Request, ctx: Ctx) {
  const guard = await guardAuthor();
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  if (!validId(id)) return jsonError(400, "invalid_id");
  try {
    const owned = await loadOwnedVideo(id, guard.author);
    if (!owned) return jsonError(404, "not_found");
    if (owned === "forbidden") return jsonError(403, "forbidden");
    const { rows } = await dbQuery(
      `SELECT v.id, v.title, v.description, v.thumbnail_url, v.playback_url, v.visibility, v.status,
              v.moderation_status, v.tags, v.published_at, v.scheduled_publish_at, v.is_draft,
              v.allow_duet, v.allow_stitch, v.allow_comments, v.audio_track_id, v.product_refs,
              v.metadata->'sound_mix' AS sound_mix,
              (SELECT at.title || ' · ' || at.artist FROM audio_tracks at WHERE at.id = v.audio_track_id) AS audio_track_label,
              v.duration_ms, v.width, v.height, 
              (SELECT s.mission_id FROM creator_mission_submissions s
                WHERE s.video_id = v.id AND s.status <> 'rejected' LIMIT 1) AS mission_id,
              COALESCE((v.metadata->>'captions_enabled')::boolean, false) AS captions_enabled,
              v.metadata->>'preview_url' AS preview_url,
              (SELECT vpl.start_ms FROM video_product_links vpl
                WHERE vpl.video_id = v.id AND vpl.placement = 'overlay' ORDER BY vpl.sort_order LIMIT 1) AS product_overlay_ms,
              (SELECT p.title FROM marketplace_products p
                WHERE p.id::text = v.product_refs->0->>'product_id' LIMIT 1) AS product_title,
              (SELECT vus.id FROM video_upload_sessions vus
                WHERE vus.video_id = v.id ORDER BY vus.created_at DESC LIMIT 1) AS session_id,
              v.created_at, v.updated_at
         FROM videos v WHERE v.id = $1`,
      [id],
    );
    return NextResponse.json({ video: rows[0] }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "video get");
  }
}

/**
 * Detalii + publicare (draft / public / programat). Vezi lib/video/publish.ts.
 * `missionId` (uuid | null) înscrie/retrage clipul la o misiune — se aplică după
 * ce detaliile au reușit, cu codurile din lib/missions/submissions.ts.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  const guard = await guardAuthor("creatorVideoEdit");
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  if (!validId(id)) return jsonError(400, "invalid_id");
  const body = await readJson(req, VideoDetailsSchema);
  if (!body.ok) return body.response;
  try {
    const owned = await loadOwnedVideo(id, guard.author);
    if (!owned) return jsonError(404, "not_found");
    if (owned === "forbidden") return jsonError(403, "forbidden");
    const { missionId, ...details } = body.data;
    if (missionId !== undefined && !videoMissionFieldSchema.safeParse(missionId).success) {
      return jsonError(400, "invalid_mission_id");
    }
    const hasDetails = Object.values(details).some((v) => v !== undefined);
    if (!hasDetails && missionId === undefined) return jsonError(400, "no_fields");
    const result = hasDetails ? await applyVideoDetails(owned, details) : undefined;
    if (missionId === undefined) return NextResponse.json({ success: true, ...result });

    const mission = await applyVideoMissionField({ userId: owned.creator_id, videoId: owned.id, missionId });
    if (!mission.ok) {
      // Detaliile (dacă au existat) sunt deja salvate; clientul afișează doar eroarea misiunii.
      return jsonError(mission.status, mission.code, result ? { detailsSaved: true, video: result } : {});
    }
    return NextResponse.json({ success: true, ...result, mission: mission.value });
  } catch (err) {
    return errorResponse(err, "video patch");
  }
}

/** Arhivare soft (status 'deleted', ascuns). */
export async function DELETE(_req: Request, ctx: Ctx) {
  const guard = await guardAuthor("creatorVideoEdit");
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  if (!validId(id)) return jsonError(400, "invalid_id");
  try {
    const owned = await loadOwnedVideo(id, guard.author);
    if (!owned) return jsonError(404, "not_found");
    if (owned === "forbidden") return jsonError(403, "forbidden");
    await dbQuery(
      `UPDATE videos SET status = 'deleted', is_hidden = true, hidden_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id],
    );
    return NextResponse.json({ success: true });
  } catch (err) {
    return errorResponse(err, "video delete");
  }
}
