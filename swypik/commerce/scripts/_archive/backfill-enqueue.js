#!/usr/bin/env node
/**
 * Backfill enqueue runner — calls the admin reencode endpoint for every video
 * whose playback_url still points at the AliExpress CDN. The python video-worker
 * dequeues from Redis and transcodes → R2 → media.swypik.com.
 *
 * Pre-req: DB rows already cleaned up (status='uploading', no asset/session rows).
 *
 * Usage (inside web-next container):
 *   node /opt/swypik/backfill-enqueue.js
 */
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const BASE = process.env.BACKFILL_BASE_URL || "http://localhost:3000";
const BATCH_DELAY_MS = Number(process.env.BACKFILL_DELAY_MS || 250);

async function pgQuery(sql) {
  const { Client } = require("pg");
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    return (await c.query(sql)).rows;
  } finally {
    await c.end();
  }
}

async function enqueue(id, sourceUrl) {
  const res = await fetch(`${BASE}/api/admin/videos/${id}/reencode`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ADMIN_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sourceUrl }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

(async () => {
  const rows = await pgQuery(
    `SELECT id, playback_url FROM videos
      WHERE playback_url LIKE 'https://video.aliexpress-media.com/%'
        AND status = 'uploading'
      ORDER BY created_at ASC`
  );
  console.log(`[backfill] candidates: ${rows.length}`);

  let ok = 0, fail = 0;
  for (const row of rows) {
    try {
      await enqueue(row.id, row.playback_url);
      ok++;
      if (ok % 50 === 0) console.log(`[backfill] queued ${ok}/${rows.length}`);
    } catch (e) {
      fail++;
      console.error(`[backfill] FAIL ${row.id}: ${e.message}`);
      if (fail > 20 && fail / (ok + fail) > 0.5) {
        console.error("[backfill] abort: failure rate >50%");
        break;
      }
    }
    if (BATCH_DELAY_MS > 0) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }
  console.log(`[backfill] done ok=${ok} fail=${fail}`);
})().catch((e) => {
  console.error("[backfill] fatal:", e);
  process.exit(1);
});
