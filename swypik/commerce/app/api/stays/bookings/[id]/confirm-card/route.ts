/**
 * POST /api/stays/bookings/[id]/confirm-card — după confirmPayment în client:
 * verifică la Stripe că hold-ul pe card există (requires_capture) și trece
 * rezervarea în 'requested'. Idempotent; webhook-ul face același lucru.
 */
import { NextResponse } from "next/server";
import { syncCardAuthorization } from "@/lib/stays/payment";
import { idParam, limitOrThrow, requireSession, staysRoute } from "@/lib/stays/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = staysRoute("stays/bookings/confirm-card", async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession();
    await limitOrThrow(req, "confirm", session.userId, { limit: 20, window: 600 });
    const id = await idParam(ctx.params);
    return NextResponse.json({ ok: true, ...(await syncCardAuthorization(id, session.userId)) });
});
