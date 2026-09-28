import { withErrorHandling } from "@/lib/api-handler";
/**
 * Cron Job: Publish scheduled videos.
 *
 * Selects videos where scheduled_publish_at <= now() and published_at is null.
 * Sets is_draft=false, scheduled_publish_at=null, published_at=now(),
 * visibility='public'.
 *
 * Auth: CRON_SECRET (Bearer / x-cron-secret header).
 */

import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { timingSafeEqual } from "crypto";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { autoEmbedVideo } from "@/lib/ai/auto-embed";
import { notifyPendingPublishedVideos } from "@/lib/video/publish-notify";

export const dynamic = "force-dynamic";

async function authorize(req: Request) {
  const authHeader = req.headers.get("authorization");
  const token =
    authHeader?.replace("Bearer ", "") ||
    req.headers.get("x-cron-secret") ||
    req.headers.get("cron-secret") ||
    req.headers.get("CRON_SECRET") ||
    "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !token) return false;
  if (Buffer.byteLength(token) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

async function run(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { rows } = await dbQuery<{ id: string; title: string | null; description: string | null }>(
    `UPDATE videos
        SET is_draft = false,
            scheduled_publish_at = NULL,
            published_at = COALESCE(published_at, now()),
            visibility = 'public',
            updated_at = now()
      WHERE scheduled_publish_at IS NOT NULL
        AND scheduled_publish_at <= now()
        AND status = 'ready'
      RETURNING id, title, description`,
  );
  // Moderarea nu mai blochează publicarea programată: un clip încă în review
  // devine public, dar rămâne în afara feed-ului (effective_label, migrarea
  // 0012) până la aprobare. Clipurile încă în procesare se publică la
  // următoarea rulare, după ce devin 'ready'.
  for (const r of rows) autoEmbedVideo(r.id, r.title, r.description);
  // Followerii sunt anunțați o singură dată, când clipul chiar e vizibil
  // (inclusiv clipurile publicate cât încă se procesau sau aprobate ulterior).
  const notified = await notifyPendingPublishedVideos();

  return NextResponse.json({
    success: true,
    published: rows.length,
    notified,
    ids: rows.map((r) => r.id),
  });
}

async function handleGET(req: Request) {
  return run(req);
}

async function handlePOST(req: Request) {
  return run(req);
}

async function GET_impl(req: Request) {
  const res = await runCron("publish-scheduled", () => handleGET(req as any));
  return res ?? cronSkippedResponse("publish-scheduled");
}

async function POST_impl(req: Request) {
  const res = await runCron("publish-scheduled", () => handlePOST(req as any));
  return res ?? cronSkippedResponse("publish-scheduled");
}

export const GET = withErrorHandling(GET_impl);
export const POST = withErrorHandling(POST_impl);
