/**
 * Căutare Stays în inventarul gazdelor Swypik (public, rate-limited).
 *   GET  /api/stays/search?q=&checkIn=&checkOut=&guests=
 *   POST /api/stays/search { q?, city?, checkIn?, checkOut?, guests? }
 * Nu depinde de furnizori externi → nu mai răspunde 503 (audit stays.md §2).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthSession } from "@/lib/auth/session";
import { staysConfig } from "@/lib/stays/config";
import { staysError } from "@/lib/stays/errors";
import { limitOrThrow, staysRoute } from "@/lib/stays/route";
import { searchStays } from "@/lib/stays/search";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const schema = z.object({
    q: z.string().trim().max(80).optional(),
    city: z.string().trim().max(80).optional(),
    checkIn: z.string().regex(DATE).optional(),
    checkOut: z.string().regex(DATE).optional(),
    guests: z.coerce.number().int().min(1).max(50).optional(),
});

async function run(req: Request, raw: unknown): Promise<Response> {
    await limitOrThrow(req, "search", null, { limit: 30, window: 60 });
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) return staysError("invalid_input");
    const d = parsed.data;
    const session = await getAuthSession().catch(() => null);
    const results = await searchStays({
        q: d.q || d.city || null,
        checkIn: d.checkIn,
        checkOut: d.checkOut,
        guests: d.guests,
        limit: staysConfig.searchLimit(),
        excludeHostUserId: session?.userId ?? null,
    });
    return NextResponse.json({ results });
}

export const GET = staysRoute("stays/search", async (req: Request) => {
    const sp = new URL(req.url).searchParams;
    const res = await run(req, Object.fromEntries([...sp.entries()].filter(([, v]) => v !== "")));
    // Vizitatorii anonimi primesc același rezultat → edge; logat = își exclude propriile anunțuri → private.
    return applyCachePolicy(res, "stays/search", req);
});

export const POST = staysRoute("stays/search", async (req: Request) => run(req, await req.json().catch(() => null)));
