/**
 * Coada de procesare video (Postgres, lib/queue/video-jobs.ts) — vedere admin.
 *
 * GET  /api/admin/video-queue → metrici (queued, retry programat, running,
 *      lease-uri expirate, dead-letter, workeri activi, vârsta celui mai vechi
 *      job) + ultimele joburi din dead-letter.
 * POST /api/admin/video-queue { action: "requeue", jobId } → reia un job din dead-letter.
 *
 * Protejat: requireAdmin(req, "system") (ops/owner sau Bearer ADMIN_SECRET).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/security/admin-audit";
import { rateLimit } from "@/lib/security/rate-limit";
import { getVideoQueueMetrics, listDeadLetters, requeueDeadLetter, videoQueueBackend } from "@/lib/queue/video-jobs";
import { uuidParamSchema } from "@/lib/validation/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ActionSchema = z.object({ action: z.literal("requeue"), jobId: uuidParamSchema });

export async function GET(req: Request) {
  const actor = await requireAdmin(req, "system");
  if (actor instanceof NextResponse) return actor;
  const [metrics, deadLetters] = await Promise.all([getVideoQueueMetrics(), listDeadLetters(50)]);
  return NextResponse.json({ backend: videoQueueBackend(), metrics, deadLetters });
}

export async function POST(req: Request) {
  const actor = await requireAdmin(req, "system");
  if (actor instanceof NextResponse) return actor;
  const rl = await rateLimit("adminVideoQueue", actor.userId ?? "machine", { limit: 30, window: 60 });
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const ok = await requeueDeadLetter(parsed.data.jobId);
  if (!ok) return NextResponse.json({ error: "not_requeueable" }, { status: 409 });
  await logAdminAction({
    actor,
    action: "video_queue.requeue",
    targetType: "video_processing_job",
    targetId: parsed.data.jobId,
    req,
  });
  return NextResponse.json({ ok: true });
}
