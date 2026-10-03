import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/security/rate-limit";
import { loadOwnedVideo } from "@/lib/video/auth";
import { generateCaptions, listCaptionTracks, saveCaptions } from "@/lib/video/captions";
import { errorResponse, guardAuthor, jsonError, readJson, validId } from "@/lib/video/upload/http";
import { SaveCaptionsSchema } from "@/lib/video/upload/schemas";
import { moderateVideoText } from "@/lib/video/text-moderation";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

const GenerateSchema = z.object({ lang: z.string().trim().regex(/^[a-z]{2}$/) });

async function owned(ctx: Ctx, limitKey?: "creatorVideoEdit") {
  const guard = await guardAuthor(limitKey);
  if (!guard.ok) return { error: guard.response } as const;
  const { id } = await ctx.params;
  if (!validId(id)) return { error: jsonError(400, "invalid_id") } as const;
  const video = await loadOwnedVideo(id, guard.author);
  if (!video) return { error: jsonError(404, "not_found") } as const;
  if (video === "forbidden") return { error: jsonError(403, "forbidden") } as const;
  return { video, author: guard.author } as const;
}

/** Pistele de subtitrare ale clipului (cu segmente, pentru editor). */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const res = await owned(ctx);
    if ("error" in res) return res.error;
    return NextResponse.json({ tracks: await listCaptionTracks(res.video.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "captions list");
  }
}

/** Generează automat subtitrarea (speech-to-text) după ce clipul e procesat. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const res = await owned(ctx);
    if ("error" in res) return res.error;
    const rl = await rateLimit("videoCaptions", res.author.userId);
    if (!rl.success) return jsonError(429, "rate_limited");
    if (res.video.status !== "ready") return jsonError(409, "not_ready");
    const body = await readJson(req, GenerateSchema);
    if (!body.ok) return body.response;
    const track = await generateCaptions(res.video.id, body.data.lang);
    // Transcrierea vorbirii e text public pe clip → aceeași moderare ca titlul.
    const moderation = await moderateVideoText({ videoId: res.video.id, text: track.text, kind: "speech" });
    return NextResponse.json({ track, held: moderation.held });
  } catch (err) {
    return errorResponse(err, "captions generate");
  }
}

/** Salvează textul editat de creator (devine is_auto=false, nu mai e suprascris). */
export async function PUT(req: Request, ctx: Ctx) {
  try {
    const res = await owned(ctx, "creatorVideoEdit");
    if ("error" in res) return res.error;
    const body = await readJson(req, SaveCaptionsSchema);
    if (!body.ok) return body.response;
    const track = await saveCaptions(res.video.id, body.data.lang, body.data.segments, res.author.userId);
    // Textul editat e servit public ca VTT: un semnal ține clipul în review.
    const moderation = await moderateVideoText({ videoId: res.video.id, text: track.text, kind: "captions" });
    return NextResponse.json({ track, held: moderation.held });
  } catch (err) {
    return errorResponse(err, "captions save");
  }
}
