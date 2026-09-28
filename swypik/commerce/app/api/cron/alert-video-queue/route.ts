import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { dbQuery } from "@/lib/db";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { checkQueue } from "@/lib/health";
import { sendEmail } from "@/lib/email/service";

export const dynamic = "force-dynamic";

const STALE_PROCESSING_MIN = Number(process.env.VIDEO_ALERT_STALE_MIN ?? 30);
const STALE_PROCESSING_THRESHOLD = Number(process.env.VIDEO_ALERT_STALE_THRESHOLD ?? 25);
// XLEN is no longer the primary signal — workers now XDEL+XTRIM after ack,
// so a fat stream usually means the trim hasn't run yet rather than a real
// backlog. Keep a very high ceiling as a last-resort tripwire only.
const QUEUE_LENGTH_THRESHOLD = Number(process.env.VIDEO_ALERT_QUEUE_LEN ?? 50_000);
const QUEUE_PENDING_THRESHOLD = Number(process.env.VIDEO_ALERT_QUEUE_PENDING ?? 200);
const QUEUE_LAG_THRESHOLD = Number(process.env.VIDEO_ALERT_QUEUE_LAG ?? 5_000);
const QUEUE_FAILED_THRESHOLD = Number(process.env.VIDEO_ALERT_QUEUE_FAILED ?? 50);
const DB_QUEUED_THRESHOLD = Number(process.env.VIDEO_ALERT_DB_QUEUED ?? 500);
const COOLDOWN_MIN = Number(process.env.VIDEO_ALERT_COOLDOWN_MIN ?? 60);
const ALERT_TO = process.env.VIDEO_ALERT_EMAIL || process.env.ADMIN_ALERT_EMAIL || "";

function authorize(req: Request): boolean {
  const header =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    req.headers.get("x-cron-secret") ||
    req.headers.get("cron-secret") ||
    "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !header) return false;
  if (Buffer.byteLength(header) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

interface StaleProcessing {
  count: number;
  oldest_minutes: number | null;
}

interface DbQueueCounts {
  queued: number;
  running: number;
  failed: number;
}

async function dbQueueCounts(): Promise<DbQueueCounts> {
  const r = await dbQuery<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n
       FROM video_processing_jobs
      WHERE status IN ('queued','running','failed')
      GROUP BY status`
  );
  const out: DbQueueCounts = { queued: 0, running: 0, failed: 0 };
  for (const row of r.rows) {
    if (row.status === 'queued') out.queued = Number(row.n);
    else if (row.status === 'running') out.running = Number(row.n);
    else if (row.status === 'failed') out.failed = Number(row.n);
  }
  return out;
}

async function staleProcessing(): Promise<StaleProcessing> {
  const r = await dbQuery<{ n: string; oldest_minutes: string | null }>(
    `SELECT COUNT(*)::text AS n,
            EXTRACT(EPOCH FROM (now() - MIN(updated_at)))::int / 60 AS oldest_minutes
       FROM videos
      WHERE status IN ('processing','uploading','queued','pending')
        AND updated_at < now() - ($1::int * INTERVAL '1 minute')`,
    [STALE_PROCESSING_MIN]
  );
  const row = r.rows[0] || { n: "0", oldest_minutes: null };
  return {
    count: Number(row.n || 0),
    oldest_minutes: row.oldest_minutes != null ? Number(row.oldest_minutes) : null,
  };
}

async function loadCooldown(key: string): Promise<Date | null> {
  const r = await dbQuery<{ alerted_at: Date }>(
    `SELECT alerted_at FROM ops_alert_log WHERE alert_key = $1 ORDER BY alerted_at DESC LIMIT 1`,
    [key]
  );
  return r.rows[0]?.alerted_at ?? null;
}

async function persistAlert(key: string, payload: unknown) {
  await dbQuery(
    `INSERT INTO ops_alert_log (alert_key, payload, alerted_at) VALUES ($1, $2, now())`,
    [key, JSON.stringify(payload)]
  );
}

interface Breach {
  metric: string;
  value: number | string;
  threshold: number | string;
}

function evaluateBreaches(
  stale: StaleProcessing,
  queue: Awaited<ReturnType<typeof checkQueue>>,
  dbq: DbQueueCounts,
): Breach[] {
  const breaches: Breach[] = [];
  // Primary signals: DB-level work that's actually stuck or piling up.
  if (stale.count >= STALE_PROCESSING_THRESHOLD) {
    breaches.push({ metric: `videos.processing > ${STALE_PROCESSING_MIN}min`, value: stale.count, threshold: STALE_PROCESSING_THRESHOLD });
  }
  if (dbq.queued >= DB_QUEUED_THRESHOLD) {
    breaches.push({ metric: "video_processing_jobs.queued", value: dbq.queued, threshold: DB_QUEUED_THRESHOLD });
  }
  if (dbq.failed >= QUEUE_FAILED_THRESHOLD) {
    breaches.push({ metric: "video_processing_jobs.failed", value: dbq.failed, threshold: QUEUE_FAILED_THRESHOLD });
  }
  // Redis-side: lag and pending are the actionable signals; XLEN is a soft
  // tripwire only (XTRIM keeps it bounded under normal operation).
  const d = (queue.detail || {}) as Record<string, number>;
  if ((d.pending ?? 0) >= QUEUE_PENDING_THRESHOLD) {
    breaches.push({ metric: "consumer pending", value: d.pending, threshold: QUEUE_PENDING_THRESHOLD });
  }
  if ((d.lag ?? 0) >= QUEUE_LAG_THRESHOLD) {
    breaches.push({ metric: "consumer lag", value: d.lag, threshold: QUEUE_LAG_THRESHOLD });
  }
  if ((d.failed ?? 0) >= QUEUE_FAILED_THRESHOLD) {
    breaches.push({ metric: "failed stream length", value: d.failed, threshold: QUEUE_FAILED_THRESHOLD });
  }
  if ((d.length ?? 0) >= QUEUE_LENGTH_THRESHOLD) {
    breaches.push({ metric: "redis stream length", value: d.length, threshold: QUEUE_LENGTH_THRESHOLD });
  }
  // Coada Postgres (implicită): lease expirat = worker mort în timpul unui job;
  // dead-letter = reîncercări epuizate, cer intervenție (/api/admin/video-queue).
  if ((d.expired_leases ?? 0) > 0) {
    breaches.push({ metric: "expired leases (dead workers)", value: d.expired_leases, threshold: 1 });
  }
  if ((d.dead_letter ?? 0) >= QUEUE_FAILED_THRESHOLD) {
    breaches.push({ metric: "dead-letter jobs", value: d.dead_letter, threshold: QUEUE_FAILED_THRESHOLD });
  }
  return breaches;
}

function renderHtml(breaches: Breach[], stale: StaleProcessing, queue: Awaited<ReturnType<typeof checkQueue>>): string {
  const rows = breaches
    .map((b) => `<tr><td>${b.metric}</td><td><strong>${b.value}</strong></td><td>&ge; ${b.threshold}</td></tr>`)
    .join("");
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif">
<h2 style="color:#b91c1c">[Swypik] Video queue alert</h2>
<p>One or more video pipeline metrics exceeded thresholds.</p>
<table cellpadding="6" style="border-collapse:collapse;border:1px solid #ddd">
<thead><tr style="background:#f3f4f6"><th>Metric</th><th>Value</th><th>Threshold</th></tr></thead>
<tbody>${rows}</tbody></table>
<h3>Snapshot</h3>
<pre style="background:#f9fafb;padding:10px;border-radius:4px">${JSON.stringify({ stale, queue }, null, 2)}</pre>
<p>Cooldown: ${COOLDOWN_MIN} min. Source: <code>/api/cron/alert-video-queue</code></p>
</body></html>`;
}

async function run() {
  const [stale, queue, dbq] = await Promise.all([staleProcessing(), checkQueue(), dbQueueCounts()]);
  const breaches = evaluateBreaches(stale, queue, dbq);
  const out: Record<string, unknown> = {
    ts: new Date().toISOString(),
    stale,
    db_queue: dbq,
    queue,
    breaches,
    alerted: false,
    skipped_reason: undefined,
  };

  if (breaches.length === 0) {
    return out;
  }

  const alertKey = "video_queue";
  const last = await loadCooldown(alertKey).catch(() => null);
  if (last && Date.now() - last.getTime() < COOLDOWN_MIN * 60_000) {
    out.skipped_reason = "cooldown";
    return out;
  }

  if (!ALERT_TO) {
    out.skipped_reason = "no_recipient";
    await persistAlert(alertKey, { ...out, suppressed: true }).catch(() => undefined);
    return out;
  }

  const html = renderHtml(breaches, stale, queue);
  const subject = `[Swypik] Video queue: ${breaches.length} threshold breach(es)`;
  const ok = await sendEmail({ to: ALERT_TO, subject, html, marketing: false });
  out.alerted = ok;
  await persistAlert(alertKey, out).catch(() => undefined);
  return out;
}

async function GET_impl(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const res = await runCron("alert-video-queue", async () => {
    const summary = await run();
    return NextResponse.json(summary);
  });
  return res ?? cronSkippedResponse("alert-video-queue");
}

async function POST_impl(req: Request) {
  return GET(req);
}

export const GET = withErrorHandling(GET_impl);
export const POST = withErrorHandling(POST_impl);
