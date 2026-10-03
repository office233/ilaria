/**
 * GET /api/geo/reverse?lat=…&lng=… — proxy Nominatim reverse (cache 24h).
 * Folosit de UI pentru „adresa mea curentă" din geolocation.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { geoReverse } from "@/lib/geo/nominatim";
import { logger } from "@/lib/logger";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger.child({ route: "geo-reverse" });

const QuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

export async function GET(req: Request) {
  const rl = await rateLimit("geoSearch", getClientIP(req));
  if (!rl.success) {
    return NextResponse.json({ error: "Prea multe cereri." }, { status: 429 });
  }
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    lat: url.searchParams.get("lat"),
    lng: url.searchParams.get("lng"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Coordonate invalide." }, { status: 400 });
  }
  try {
    const result = await geoReverse(parsed.data.lat, parsed.data.lng);
    return applyCachePolicy(NextResponse.json({ result }), "geo/reverse", req);
  } catch (e) {
    log.warn({ err: (e as Error).message }, "geo reverse failed");
    return NextResponse.json({ result: null });
  }
}
