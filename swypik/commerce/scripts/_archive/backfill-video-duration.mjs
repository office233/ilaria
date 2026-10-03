#!/usr/bin/env node
/**
 * Backfill videos.duration_ms by fetching HLS master + first variant playlist
 * and summing EXTINF durations.
 *
 * Reads playback_url, follows it to master.m3u8, picks first variant, sums
 * EXTINF lines, writes duration_ms back.
 *
 * Env:
 *   DATABASE_URL  (required, supports @postgres → @127.0.0.1 rewrite)
 *   CONCURRENCY   (default 8)
 *   LIMIT         (default 0 = all)
 *   DRY           (default 0 = apply)
 *   MEDIA_HOST    (default media.swypik.com)
 */
import pg from 'pg';
const { Pool } = pg;

const RAW = process.env.DATABASE_URL;
if (!RAW) { console.error('DATABASE_URL missing'); process.exit(1); }
const url = new URL(RAW);
if (url.hostname === 'postgres') url.hostname = '127.0.0.1';
const pool = new Pool({ connectionString: url.toString(), max: 6 });

const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const LIMIT = Number(process.env.LIMIT || 0);
const DRY = process.env.DRY === '1';
const MEDIA_HOST = process.env.MEDIA_HOST || 'media.swypik.com';

function rewriteUrl(playbackUrl) {
  if (!playbackUrl) return null;
  let u;
  try { u = new URL(playbackUrl, `https://${MEDIA_HOST}`); }
  catch { return null; }
  if (u.host === 'media.swypik.com' || u.host === MEDIA_HOST) return u.toString();
  if (u.pathname.startsWith('/media/')) {
    return `https://${MEDIA_HOST}${u.pathname.replace(/^\/media/, '')}${u.search}`;
  }
  if (u.pathname.startsWith('/videos/')) {
    return `https://${MEDIA_HOST}${u.pathname}${u.search}`;
  }
  return u.toString();
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function pickFirstVariant(masterText, masterUrl) {
  const lines = masterText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const next = (lines[i + 1] || '').trim();
      if (next && !next.startsWith('#')) {
        return new URL(next, masterUrl).toString();
      }
    }
  }
  return null;
}

function sumExtinf(text) {
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#EXTINF:')) {
      const m = line.match(/#EXTINF:([0-9.]+)/);
      if (m) total += parseFloat(m[1]);
    }
  }
  return total;
}

async function durationFor(playbackUrl) {
  const masterUrl = rewriteUrl(playbackUrl);
  if (!masterUrl) return null;
  let text;
  try { text = await fetchText(masterUrl); }
  catch (e) { return { error: `master: ${e.message}` }; }

  let target = masterUrl;
  if (text.includes('#EXT-X-STREAM-INF')) {
    const v = pickFirstVariant(text, masterUrl);
    if (!v) return { error: 'no variant' };
    try { text = await fetchText(v); target = v; }
    catch (e) { return { error: `variant: ${e.message}` }; }
  }

  const total = sumExtinf(text);
  if (total <= 0) return { error: 'no EXTINF' };
  return { ms: Math.round(total * 1000), source: target };
}

async function main() {
  const limitSql = LIMIT > 0 ? ` LIMIT ${LIMIT}` : '';
  const { rows } = await pool.query(
    `SELECT id::text AS id, playback_url
       FROM videos
      WHERE status = 'ready'
        AND (duration_ms IS NULL OR duration_ms = 0)
        AND playback_url IS NOT NULL
        AND playback_url <> ''
      ORDER BY published_at DESC NULLS LAST${limitSql}`
  );

  console.log(`[backfill] mode=${DRY ? 'DRY' : 'APPLY'} concurrency=${CONCURRENCY} pending=${rows.length}`);
  if (!rows.length) { await pool.end(); return; }

  let done = 0, ok = 0, fail = 0;
  const failures = [];

  async function worker(slice) {
    for (const row of slice) {
      const res = await durationFor(row.playback_url);
      done++;
      if (res && res.ms) {
        ok++;
        if (!DRY) {
          try {
            await pool.query(
              `UPDATE videos SET duration_ms = $1, updated_at = NOW()
                WHERE id = $2 AND (duration_ms IS NULL OR duration_ms = 0)`,
              [res.ms, row.id]
            );
          } catch (e) {
            fail++; ok--;
            failures.push({ id: row.id, err: `db: ${e.message}` });
          }
        }
      } else {
        fail++;
        failures.push({ id: row.id, err: res?.error || 'unknown', url: row.playback_url });
      }
      if (done % 200 === 0) {
        console.log(`[backfill] progress ${done}/${rows.length} ok=${ok} fail=${fail}`);
      }
    }
  }

  const slices = Array.from({ length: CONCURRENCY }, () => []);
  rows.forEach((r, i) => slices[i % CONCURRENCY].push(r));
  await Promise.all(slices.map(worker));

  console.log(`[backfill] done total=${done} ok=${ok} fail=${fail}`);
  if (failures.length) {
    console.log(`[backfill] first 5 failures:`);
    failures.slice(0, 5).forEach(f => console.log(`  ${f.id}: ${f.err}`));
  }
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
