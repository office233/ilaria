/**
 * GET /api/stays/local?city=Brasov — compatibilitate: aceeași căutare ca
 * /api/stays/search (inventarul gazdelor Swypik), fără filtre de date.
 */
import { NextResponse } from "next/server";
import { limitOrThrow, staysRoute } from "@/lib/stays/route";
import { searchStays } from "@/lib/stays/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = staysRoute("stays/local", async (req: Request) => {
    await limitOrThrow(req, "search", null, { limit: 30, window: 60 });
    const city = new URL(req.url).searchParams.get("city")?.trim().slice(0, 80) || null;
    return NextResponse.json({ results: await searchStays({ q: city }) });
});
