import { NextRequest, NextResponse } from "next/server";
import { moderateText } from "@/lib/moderation/moderateText";
import {
  searchAll,
  searchCreators,
  searchHashtags,
  searchProducts,
  searchVideos,
} from "@/lib/search/query";
import { getClientIP, rateLimit } from "@/lib/security/rate-limit";

import { logger } from "@/lib/logger";
export const dynamic = "force-dynamic";

type SearchType = "all" | "videos" | "creators" | "products" | "hashtags";

const PAGE_LIMIT = 20;

function parseType(v: string | null): SearchType {
  if (v === "videos" || v === "creators" || v === "products" || v === "hashtags") return v;
  return "all";
}

function parseInt32(v: string | null, def: number, min: number, max: number) {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const q = (url.searchParams.get("q") ?? "").trim();
    const __mod = moderateText(typeof q === "string" ? q : "", "search");
    if (__mod.action === "reject") {
      return NextResponse.json({ items: [], total: 0, blocked: true, reason: __mod.message }, { status: 200 });
    }
  const type = parseType(url.searchParams.get("type"));
  const limit = parseInt32(url.searchParams.get("limit"), PAGE_LIMIT, 1, 50);
  const offset = parseInt32(url.searchParams.get("offset"), 0, 0, 10_000);
  const { success: allowed } = await rateLimit("search", getClientIP(req), { limit: 60, window: 60 });
  if (!allowed) {
    return NextResponse.json({ error: "Too many search requests" }, { status: 429 });
  }

  if (q.length < 2) {
    return NextResponse.json(
      { error: "Query too short", q, type },
      { status: 400 }
    );
  }

  try {
    if (type === "all") {
      const results = await searchAll(q);
      const hasMore =
        results.videos.length === 10 ||
        results.creators.length === 10 ||
        results.products.length === 10 ||
        results.hashtags.length === 10;
      return NextResponse.json({ q, type, results, hasMore });
    }

    if (type === "videos") {
      const items = await searchVideos(q, { limit, offset });
      return NextResponse.json({
        q,
        type,
        results: { videos: items },
        hasMore: items.length === limit,
      });
    }

    if (type === "creators") {
      const items = await searchCreators(q, { limit, offset });
      return NextResponse.json({
        q,
        type,
        results: { creators: items },
        hasMore: items.length === limit,
      });
    }

    if (type === "hashtags") {
      const items = await searchHashtags(q, { limit, offset });
      return NextResponse.json({
        q,
        type,
        results: { hashtags: items },
        hasMore: items.length === limit,
      });
    }

    // products
    const items = await searchProducts(q, { limit, offset });
    return NextResponse.json({
      q,
      type,
      results: { products: items },
      hasMore: items.length === limit,
    });
  } catch (err) {
    logger.error({ err: err }, "[/api/search] error:");
    return NextResponse.json(
      { error: "Search failed", q, type },
      { status: 500 }
    );
  }
}
