/**
 * PATCH  /api/host/listings/[id]
 *   { action: "publish" | "unpublish" }  → schimbă vizibilitatea
 *   { ...listare completă }               → editează (formularul din panou)
 * DELETE /api/host/listings/[id] — arhivează (refuzat cu rezervări viitoare).
 * Doar proprietarul (metadata.host_user_id), doar gazde active.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { staysError } from "@/lib/stays/errors";
import { requireHost } from "@/lib/stays/hosts";
import { archiveListing, listingSchema, setPublished, updateListing } from "@/lib/stays/listings";
import { idParam, limitOrThrow, requireSession, staysRoute } from "@/lib/stays/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actionSchema = z.object({ action: z.enum(["publish", "unpublish"]) });
type Ctx = { params: Promise<{ id: string }> };

export const PATCH = staysRoute("host/listings:patch", async (req: Request, ctx: Ctx) => {
    const session = await requireSession();
    await limitOrThrow(req, "host-listing", session.userId, { limit: 60, window: 3600 });
    const host = await requireHost(session.userId);
    const id = await idParam(ctx.params);
    const body: unknown = await req.json().catch(() => null);

    const action = actionSchema.safeParse(body);
    if (action.success) {
        const status = await setPublished(id, session.userId, action.data.action === "publish");
        return NextResponse.json({ ok: true, status });
    }
    const parsed = listingSchema().safeParse(body);
    if (!parsed.success) return staysError("invalid_input");
    await updateListing(id, session.userId, host, parsed.data);
    return NextResponse.json({ ok: true });
});

export const DELETE = staysRoute("host/listings:delete", async (req: Request, ctx: Ctx) => {
    const session = await requireSession();
    await limitOrThrow(req, "host-listing", session.userId, { limit: 20, window: 3600 });
    await requireHost(session.userId);
    await archiveListing(await idParam(ctx.params), session.userId);
    return NextResponse.json({ ok: true });
});
