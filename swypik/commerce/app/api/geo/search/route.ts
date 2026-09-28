/**
 * GET /api/geo/search?q=… — proxy Nominatim search (cache Redis 24h,
 * rate limit, User-Agent corect). AddressAutocomplete apelează ruta asta,
 * nu nominatim.org direct.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { geoSearch } from "@/lib/geo/nominatim";
import { logger } from "@/lib/logger";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger.child({ route: "geo-search" });

const QuerySchema = z.object({ q: z.string().trim().min(3).max(200) });

export async function GET(req: Request) {
  const rl = await rateLimit("geoSearch", getClientIP(req));
  if (!rl.success) {
    return NextResponse.json({ error: "Prea multe cereri." }, { status: 429 });
  }
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({ q: url.searchParams.get("q") ?? "" });
  if (!parsed.success) {
    return NextResponse.json({ results: [] });
  }
  try {
    const results = await geoSearch(parsed.data.q);
    return applyCachePolicy(NextResponse.json({ results }), "geo/search", req);
  } catch (e) {
    log.warn({ err: (e as Error).message }, "geo search failed");
    return NextResponse.json({ results: [] });
  }
}
