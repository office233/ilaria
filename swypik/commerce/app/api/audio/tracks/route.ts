import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface AudioTrackDTO {
  id: number;
  source: string;
  sourceId: string;
  title: string;
  artist: string;
  durationS: number;
  audioUrl: string;
  imageUrl: string | null;
  tags: string[];
  genre: string | null;
  attributionUrl: string | null;
  popularity: number;
}

/**
 * GET /api/audio/tracks
 *
 * Query params:
 *   id      — o singură piesă (eticheta sunetului preselectat din /upload?audio=<id>)
 *   q       — case-insensitive search across title/artist/tags (optional)
 *   genre   — exact genre match (optional)
 *   limit   — page size, default 20, max 100
 *   offset  — pagination offset, default 0
 *   sort    — "popular" (default) | "recent" | "duration"
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim() || "";
    const genre = url.searchParams.get("genre")?.trim() || "";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    const sort = url.searchParams.get("sort") || "popular";
    const idRaw = url.searchParams.get("id")?.trim() || "";
    if (idRaw && !/^[1-9]\d{0,11}$/.test(idRaw)) {
      return NextResponse.json({ error: "invalid_id" }, { status: 400 });
    }

    // Platformă monetizată: reels/feed folosesc doar sunete licențiate comercial (vezi lib/audio/license.ts).
    const where: string[] = ["is_active = true", "licensed_for_commercial = true"];
    const params: unknown[] = [];

    if (idRaw) {
      params.push(Number(idRaw));
      where.push(`id = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(`(title ILIKE $${i} OR artist ILIKE $${i} OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE $${i}))`);
    }
    if (genre) {
      params.push(genre);
      where.push(`genre = $${params.length}`);
    }

    const orderBy =
      sort === "recent" ? "created_at DESC" :
      sort === "duration" ? "duration_s ASC" :
      "popularity DESC, plays_count DESC";

    params.push(limit, offset);
    const sql = `
      SELECT id, source, source_id, title, artist, duration_s,
             audio_url, image_url, tags, genre, attribution_url, popularity
      FROM audio_tracks
      WHERE ${where.join(" AND ")}
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const { rows } = await dbQuery<{
      id: number;
      source: string;
      source_id: string;
      title: string;
      artist: string;
      duration_s: number;
      audio_url: string;
      image_url: string | null;
      tags: string[];
      genre: string | null;
      attribution_url: string | null;
      popularity: number;
    }>(sql, params);

    const tracks: AudioTrackDTO[] = rows.map((r) => ({
      id: Number(r.id),
      source: r.source,
      sourceId: r.source_id,
      title: r.title,
      artist: r.artist,
      durationS: r.duration_s,
      audioUrl: r.audio_url,
      imageUrl: r.image_url,
      tags: r.tags ?? [],
      genre: r.genre,
      attributionUrl: r.attribution_url,
      popularity: r.popularity,
    }));

    return applyCachePolicy(
      NextResponse.json({ tracks, limit, offset, hasMore: tracks.length === limit }),
      "audio/tracks",
      request,
    );
  } catch (err) {
    logger.error({ err }, "/api/audio/tracks failed");
    return NextResponse.json({ error: "failed to load tracks" }, { status: 500 });
  }
}