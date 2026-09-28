#!/usr/bin/env node
/**
 * Jamendo sync: pull top N tracks by popularity_total, download MP3, upload to R2, insert/update DB.
 *
 * Usage (inside web-next container, after docker exec):
 *   node /opt/swypik/app/scripts/sync-jamendo.mjs --limit 1000 [--dry-run]
 *
 * Env required:
 *   DATABASE_URL
 *   JAMENDO_CLIENT_ID
 *   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, MEDIA_PUBLIC_BASE_URL (sau R2_PUBLIC_URL)
 */

import { Pool } from "pg";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Buffer } from "node:buffer";

const JAMENDO_BASE = "https://api.jamendo.com/v3.0";
const PAGE_SIZE = 200; // Jamendo max per request

function parseArgs(argv) {
  const opts = { limit: 1000, dryRun: false, concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") opts.limit = parseInt(argv[++i], 10);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--concurrency") opts.concurrency = parseInt(argv[++i], 10);
  }
  return opts;
}

async function jamendoFetchPage(offset, limit) {
  const clientId = process.env.JAMENDO_CLIENT_ID;
  if (!clientId) throw new Error("JAMENDO_CLIENT_ID missing");
  const url = new URL(`${JAMENDO_BASE}/tracks/`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("boost", "popularity_total");
  url.searchParams.set("include", "musicinfo licenses stats");
  url.searchParams.set("audioformat", "mp32"); // mp3 320kbps where available
  // only fully usable for streaming
  url.searchParams.set("imagesize", "300");

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Jamendo ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data?.headers?.status !== "success") {
    throw new Error(`Jamendo error: ${JSON.stringify(data?.headers)}`);
  }
  return data.results ?? [];
}

function getS3() {
  const endpoint = process.env.R2_ENDPOINT || process.env.S3_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 credentials missing");
  }
  return new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function r2Exists(s3, bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return false;
    throw e;
  }
}

async function uploadToR2(s3, bucket, key, body, contentType) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

async function downloadBuffer(url, maxBytes = 10 * 1024 * 1024) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`download ${res.status} ${url}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len && len > maxBytes) throw new Error(`too large ${len} > ${maxBytes}`);
  const ab = await res.arrayBuffer();
  if (ab.byteLength > maxBytes) throw new Error(`too large ${ab.byteLength}`);
  return Buffer.from(ab);
}

function extractGenre(track) {
  const tags = track?.musicinfo?.tags?.genres ?? [];
  if (tags.length > 0) return String(tags[0]).toLowerCase();
  return null;
}

function extractTags(track) {
  const m = track?.musicinfo?.tags ?? {};
  const all = [
    ...(m.genres ?? []),
    ...(m.instruments ?? []),
    ...(m.vartags ?? []),
  ];
  return [...new Set(all.map((t) => String(t).toLowerCase()).filter(Boolean))].slice(0, 20);
}

async function processTrack(track, opts, s3, bucket, publicBase, pool, stats) {
  const id = String(track.id);
  const audioUrl = track.audiodownload || track.audio;
  if (!audioUrl) {
    stats.skipped++;
    return;
  }

  const audioKey = `audio/jamendo/${id}.mp3`;
  const imageKey = track.image ? `audio/jamendo/${id}.jpg` : null;
  const audioR2Url = `${publicBase.replace(/\/$/, "")}/${audioKey}`;
  const imageR2Url = imageKey ? `${publicBase.replace(/\/$/, "")}/${imageKey}` : null;

  if (!opts.dryRun) {
    // audio (skip if already on R2)
    const audioExists = await r2Exists(s3, bucket, audioKey);
    if (!audioExists) {
      const buf = await downloadBuffer(audioUrl);
      await uploadToR2(s3, bucket, audioKey, buf, "audio/mpeg");
      stats.audioUploaded++;
    } else {
      stats.audioSkipped++;
    }

    // image (best effort)
    if (track.image && imageKey) {
      try {
        const imgExists = await r2Exists(s3, bucket, imageKey);
        if (!imgExists) {
          const buf = await downloadBuffer(track.image, 2 * 1024 * 1024);
          await uploadToR2(s3, bucket, imageKey, buf, "image/jpeg");
          stats.imageUploaded++;
        }
      } catch (e) {
        // image is optional
        console.warn(`  ! image fail ${id}: ${e.message}`);
      }
    }
  }

  const tags = extractTags(track);
  const genre = extractGenre(track);
  const license = track?.license_ccurl || track?.license || null;
  const popularity = Number(track?.stats?.rate_listened_total || 0) +
    Number(track?.stats?.rate_downloads_total || 0);
  const duration = Number(track.duration) || 0;
  if (duration <= 0) {
    stats.skipped++;
    return;
  }

  if (!opts.dryRun) {
    await pool.query(
      `INSERT INTO audio_tracks
        (source, source_id, title, artist, duration_s, audio_url, image_url,
         tags, genre, license, attribution_url, popularity, is_active, updated_at)
       VALUES ('jamendo', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, NOW())
       ON CONFLICT (source, source_id) DO UPDATE SET
         title = EXCLUDED.title,
         artist = EXCLUDED.artist,
         duration_s = EXCLUDED.duration_s,
         audio_url = EXCLUDED.audio_url,
         image_url = EXCLUDED.image_url,
         tags = EXCLUDED.tags,
         genre = EXCLUDED.genre,
         license = EXCLUDED.license,
         attribution_url = EXCLUDED.attribution_url,
         popularity = EXCLUDED.popularity,
         is_active = TRUE,
         updated_at = NOW()`,
      [
        id,
        String(track.name || "Untitled").slice(0, 500),
        String(track.artist_name || "Unknown").slice(0, 500),
        duration,
        audioR2Url,
        imageR2Url,
        tags,
        genre,
        license,
        track.shareurl || null,
        popularity,
      ],
    );
  }
  stats.dbWritten++;
}

async function runPool(items, concurrency, worker) {
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        await worker(item);
      } catch (e) {
        console.warn(`  ! track ${item?.id} fail: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`Jamendo sync: limit=${opts.limit} concurrency=${opts.concurrency} dryRun=${opts.dryRun}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const s3 = getS3();
  const bucket = process.env.R2_BUCKET || process.env.S3_BUCKET;
  const publicBase = process.env.MEDIA_PUBLIC_BASE_URL || process.env.R2_PUBLIC_URL || process.env.S3_PUBLIC_URL;
  if (!bucket || !publicBase) throw new Error("R2_BUCKET / MEDIA_PUBLIC_BASE_URL missing");

  const stats = { fetched: 0, dbWritten: 0, audioUploaded: 0, audioSkipped: 0, imageUploaded: 0, skipped: 0 };
  let offset = 0;
  const seenIds = new Set();

  while (stats.dbWritten + stats.skipped < opts.limit) {
    const remaining = opts.limit - (stats.dbWritten + stats.skipped);
    const pageLimit = Math.min(PAGE_SIZE, remaining + 50); // overshoot a bit for filtered
    console.log(`\n--- page offset=${offset} limit=${pageLimit} ---`);
    const tracks = await jamendoFetchPage(offset, pageLimit);
    if (tracks.length === 0) {
      console.log("no more tracks from Jamendo");
      break;
    }
    stats.fetched += tracks.length;
    const fresh = tracks.filter((t) => {
      const id = String(t.id);
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    await runPool(fresh, opts.concurrency, async (t) => {
      await processTrack(t, opts, s3, bucket, publicBase, pool, stats);
      if ((stats.dbWritten + stats.skipped) % 25 === 0) {
        console.log(`  progress: ${stats.dbWritten} db / ${stats.audioUploaded} audio up / ${stats.skipped} skip`);
      }
    });

    offset += tracks.length;
    if (tracks.length < pageLimit - 50) break; // last page
  }

  console.log("\n=== DONE ===");
  console.log(stats);
  await pool.end();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
