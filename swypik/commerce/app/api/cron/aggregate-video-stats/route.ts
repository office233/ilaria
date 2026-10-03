import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { dbQuery } from "@/lib/db";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";

export const dynamic = "force-dynamic";

const AGGREGATE_DAYS = Number(process.env.VIDEO_STATS_AGGREGATE_DAYS ?? 7);
const SYNC_VIDEO_COUNTERS = (process.env.VIDEO_STATS_SYNC_COUNTERS ?? "1") !== "0";

function authorize(req: Request): boolean {
  const header =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    req.headers.get("x-cron-secret") ||
    "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !header) return false;
  if (Buffer.byteLength(header) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

// Map raw event_type variants to a canonical bucket used in video_stats_daily.
const EVENT_BUCKETS: Array<{ bucket: string; types: string[] }> = [
  { bucket: "impression", types: ["impression"] },
  { bucket: "view", types: ["video_view", "video_viewed"] },
  { bucket: "watch", types: ["watch_time"] },
  { bucket: "completion", types: ["completion"] },
  { bucket: "like", types: ["like", "video_liked"] },
  { bucket: "save", types: ["save", "video_saved"] },
  { bucket: "share", types: ["share", "video_shared"] },
  { bucket: "comment", types: ["comment_created", "video_commented"] },
  { bucket: "product_click", types: ["product_click"] },
  { bucket: "add_to_cart", types: ["add_to_cart"] },
  { bucket: "purchase", types: ["purchase"] },
  { bucket: "follow", types: ["creator_followed", "follow"] },
];

async function aggregate(days: number) {
  // Build a CASE that maps event_type into a bucket. Use one big SQL upsert
  // so the cron call is a single DB round-trip per "day window".
  const bucketCase = EVENT_BUCKETS.map(
    (b) => `WHEN event_type IN (${b.types.map((t) => `'${t}'`).join(",")}) THEN '${b.bucket}'`
  ).join("\n      ");

  const result = await dbQuery<{ upserted: string }>(
    `WITH agg AS (
       SELECT
         video_id,
         (occurred_at AT TIME ZONE 'UTC')::date AS stat_date,
         COUNT(*) FILTER (WHERE bucket = 'impression')    AS impressions,
         COUNT(*) FILTER (WHERE bucket = 'view')          AS views,
         COALESCE(SUM(watch_ms) FILTER (WHERE bucket = 'watch'), 0) AS watch_ms_sum,
         COUNT(*) FILTER (WHERE bucket = 'completion')    AS completions,
         COUNT(*) FILTER (WHERE bucket = 'like')          AS likes,
         COUNT(*) FILTER (WHERE bucket = 'save')          AS saves,
         COUNT(*) FILTER (WHERE bucket = 'share')         AS shares,
         COUNT(*) FILTER (WHERE bucket = 'comment')       AS comments,
         COUNT(*) FILTER (WHERE bucket = 'product_click') AS product_clicks,
         COUNT(*) FILTER (WHERE bucket = 'add_to_cart')   AS add_to_cart,
         COUNT(*) FILTER (WHERE bucket = 'purchase')      AS purchases,
         COUNT(*) FILTER (WHERE bucket = 'follow')        AS follows
       FROM (
         SELECT video_id, occurred_at, watch_ms,
                CASE
                  ${bucketCase}
                  ELSE NULL
                END AS bucket
           FROM feed_events
          WHERE video_id IS NOT NULL
            AND occurred_at >= now() - ($1::int * INTERVAL '1 day')
       ) e
       WHERE bucket IS NOT NULL
       GROUP BY video_id, stat_date
     )
     INSERT INTO video_stats_daily (
       video_id, stat_date, impressions, views, watch_ms_sum, completions,
       likes, saves, shares, comments, product_clicks, add_to_cart, purchases, follows, computed_at
     )
     SELECT video_id, stat_date, impressions, views, watch_ms_sum, completions,
            likes, saves, shares, comments, product_clicks, add_to_cart, purchases, follows, now()
       FROM agg
     ON CONFLICT (video_id, stat_date) DO UPDATE SET
       impressions    = EXCLUDED.impressions,
       views          = EXCLUDED.views,
       watch_ms_sum   = EXCLUDED.watch_ms_sum,
       completions    = EXCLUDED.completions,
       likes          = EXCLUDED.likes,
       saves          = EXCLUDED.saves,
       shares         = EXCLUDED.shares,
       comments       = EXCLUDED.comments,
       product_clicks = EXCLUDED.product_clicks,
       add_to_cart    = EXCLUDED.add_to_cart,
       purchases      = EXCLUDED.purchases,
       follows        = EXCLUDED.follows,
       computed_at    = now()
     RETURNING video_id::text AS upserted`,
    [days]
  );

  return result.rowCount ?? result.rows.length;
}

async function syncVideoCounters() {
  // ANTI-FAKE (2026-08-09): like/save/comment se sincronizează EXACT din
  // tabelele-sursă (likes, saves, shares, comments) — NU din feed_events,
  // care sunt telemetrie NEAUTENTIFICATĂ, injectabilă anonim în masă
  // (audit anti-fraud 2026-08-09, vuln. #1). Views = vizitatori unici
  // (ip_hash prioritar), sincronizat EXACT (fără GREATEST — vuln. #5:
  // valorile frauduloase rămâneau blocate pentru totdeauna).
  const result = await dbQuery<{ id: string }>(
    `WITH truth AS (
       SELECT v.id,
              (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id)                    AS likes,
              -- aceeași definiție ca triggerul trg_comments_social_counter (doar 'visible')
              (SELECT COUNT(*) FROM comments c
                  WHERE c.video_id = v.id AND c.status = 'visible')                     AS comments,
              (SELECT COUNT(DISTINCT s.user_id) FROM saves s WHERE s.video_id = v.id)   AS saves,
              (SELECT COUNT(*) FROM shares sh WHERE sh.video_id = v.id)                 AS shares,
              (SELECT COUNT(DISTINCT COALESCE(fe.ip_hash, fe.session_id, fe.id::text)) FROM feed_events fe
                  WHERE fe.video_id = v.id AND fe.event_type IN ('video_view','video_viewed')) AS views
         FROM videos v
     )
     UPDATE videos v
        SET like_count    = t.likes,
            comment_count = t.comments,
            save_count    = t.saves,
            share_count   = t.shares,
            view_count    = t.views
       FROM truth t
      WHERE v.id = t.id
        AND (v.like_count    <> t.likes
          OR v.comment_count <> t.comments
          OR v.save_count    <> t.saves
          OR v.share_count   <> t.shares
          OR v.view_count    <> t.views)
      RETURNING v.id`
  );
  return result.rowCount ?? result.rows.length;
}

async function run() {
  const t0 = Date.now();
  const upserted = await aggregate(AGGREGATE_DAYS);
  const synced = SYNC_VIDEO_COUNTERS ? await syncVideoCounters() : 0;
  return {
    ok: true,
    aggregate_days: AGGREGATE_DAYS,
    rows_upserted: upserted,
    videos_counter_synced: synced,
    elapsed_ms: Date.now() - t0,
    ts: new Date().toISOString(),
  };
}

async function GET_impl(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const res = await runCron("aggregate-video-stats", async () => {
    const summary = await run();
    return NextResponse.json(summary);
  });
  return res ?? cronSkippedResponse("aggregate-video-stats");
}

async function POST_impl(req: Request) {
  return GET(req);
}

export const GET = withErrorHandling(GET_impl);
export const POST = withErrorHandling(POST_impl);
