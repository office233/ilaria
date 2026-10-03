/**
 * POST /api/stays/bookings/[id]/cancel — anulare de către client sau gazdă
 * (rolul se deduce din rezervare). Refund conform politicii din
 * lib/stays/policy.ts: card → Stripe (metoda originală), wallet → ledger.
 */
import { NextResponse } from "next/server";
import { cancelBooking } from "@/lib/stays/cancellation";
import { idParam, limitOrThrow, requireSession, staysRoute } from "@/lib/stays/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = staysRoute("stays/bookings/cancel", async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession();
    await limitOrThrow(req, "cancel", session.userId, { limit: 10, window: 3600 });
    const id = await idParam(ctx.params);
    return NextResponse.json({ ok: true, ...(await cancelBooking(id, session.userId)) });
});
