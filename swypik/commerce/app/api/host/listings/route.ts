/**
 * Panoul gazdei — listări de cazare (model unic, lib/stays/listings.ts).
 * GET  /api/host/listings — listările gazdei curente (+ dacă e gazdă activă).
 * POST /api/host/listings — creează o listare 'draft' (doar gazde active).
 */
import { NextResponse } from "next/server";
import { getActiveHost, requireHost } from "@/lib/stays/hosts";
import { staysError } from "@/lib/stays/errors";
import { createListing, listHostListings, listingSchema } from "@/lib/stays/listings";
import { limitOrThrow, requireSession, staysRoute } from "@/lib/stays/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = staysRoute("host/listings:get", async () => {
    const session = await requireSession();
    const host = await getActiveHost(session.userId);
    if (!host) return NextResponse.json({ approved: false, host: null, listings: [] });
    return NextResponse.json({ approved: true, host, listings: await listHostListings(session.userId) });
});

export const POST = staysRoute("host/listings:create", async (req: Request) => {
    const session = await requireSession();
    await limitOrThrow(req, "host-listing", session.userId, { limit: 20, window: 3600 });
    const host = await requireHost(session.userId);
    const parsed = listingSchema().safeParse(await req.json().catch(() => null));
    if (!parsed.success) return staysError("invalid_input");
    const listingId = await createListing(session.userId, host, parsed.data);
    return NextResponse.json({ ok: true, listingId, status: "draft" });
});
