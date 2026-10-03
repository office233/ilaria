/**
 * Backfill AliExpress-hosted videos through the hybrid pipeline.
 *
 * Selects all `videos` rows whose `playback_url` still points to the AE CDN
 * and enqueues them via `enqueueAeVideoPipeline`. The python video-worker will
 * dequeue, transcode to HLS, upload to the new R2 bucket, and update
 * `videos.playback_url` to media.swypik.com.
 *
 *   docker exec swypik-prod-web-next-1 node -r ts-node/register \
 *     scripts/backfill-ae-videos.ts [--limit=N] [--dry-run]
 *
 * Safe to re-run: ON CONFLICT in video_assets is patched, and rows already on
 * media.swypik.com are filtered out.
 */
import { dbQuery } from "@/lib/db";
import { enqueueAeVideoPipeline } from "@/lib/video/ae-pipeline";

type Row = { id: string; playback_url: string; title: string | null };

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : 99999;

  const { rows } = await dbQuery<Row>(
    `SELECT id, playback_url, title
       FROM videos
      WHERE playback_url LIKE 'https://video.aliexpress-media.com/%'
        AND status IN ('ready','uploading','processing','failed')
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit]
  );

  console.log(`[backfill] candidates: ${rows.length} (dry-run=${dryRun})`);

  let queued = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (dryRun) {
      console.log(`[dry] ${row.id} <- ${row.playback_url}`);
      continue;
    }
    try {
      // Reset video state so the worker can transcode again.
      await dbQuery(
        `DELETE FROM video_processing_jobs WHERE video_id = $1`,
        [row.id]
      );
      await dbQuery(
        `DELETE FROM video_upload_sessions WHERE video_id = $1`,
        [row.id]
      );
      await dbQuery(
        `UPDATE videos SET status='uploading', updated_at=NOW() WHERE id = $1`,
        [row.id]
      );

      const r = await enqueueAeVideoPipeline({
        sourceUrl: row.playback_url,
        existingVideoId: row.id,
        title: row.title || undefined,
        metadata: { backfill_at: new Date().toISOString() },
      });
      queued++;
      if (queued % 50 === 0) {
        console.log(`[backfill] queued=${queued}/${rows.length} last=${row.id}`);
      }
      if (!r.queued) skipped++;
    } catch (err: any) {
      failed++;
      console.error(`[backfill] FAIL ${row.id}:`, err?.message || err);
    }
  }

  console.log(
    `[backfill] done: queued=${queued} skipped=${skipped} failed=${failed} total=${rows.length}`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[backfill] fatal:", e);
  process.exit(1);
});
