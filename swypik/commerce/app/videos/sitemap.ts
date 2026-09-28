/**
 * Video sitemap — public ready videos (single sitemap, max 50k entries).
 * URL: /videos/sitemap.xml
 */

import { dbQuery } from "@/lib/db";
import type { MetadataRoute } from "next";
import { APP_URL } from "@/lib/app-url";

export const dynamic = "force-dynamic";
export const revalidate = 3600;

const BASE_URL = APP_URL;
const MAX_VIDEOS = 45000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    const { rows } = await dbQuery<{ id: string; published_at: Date | null; thumbnail_url: string | null }>(
      `SELECT id, published_at, thumbnail_url FROM videos
        WHERE status='ready' AND visibility='public'
          AND COALESCE(is_hidden, false)=false
          AND effective_label='safe'
        ORDER BY published_at DESC NULLS LAST
        LIMIT $1`,
      [MAX_VIDEOS],
    );
    return rows.map((r) => {
      const entry: MetadataRoute.Sitemap[number] = {
        url: `${BASE_URL}/video/${r.id}`,
        lastModified: r.published_at ? new Date(r.published_at) : new Date(),
        changeFrequency: "weekly",
        priority: 0.8,
      };
      if (r.thumbnail_url) (entry as any).images = [r.thumbnail_url];
      return entry;
    });
  } catch (e) {
    console.error("[VideosSitemap] fetch failed:", e);
    return [];
  }
}
