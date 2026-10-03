/**
 * POST /api/stays/bookings/[id]/create-intent — plata cu CARDUL (metoda
 * principală). PaymentIntent cu capture_method=manual: banii sunt doar
 * autorizați până când gazda acceptă (capture) sau refuză (cancel).
 */
import { NextResponse } from "next/server";
import { startCardPayment } from "@/lib/stays/payment";
import { idParam, limitOrThrow, requireSession, staysRoute } from "@/lib/stays/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = staysRoute("stays/bookings/create-intent", async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession();
    await limitOrThrow(req, "intent", session.userId, { limit: 10, window: 600 });
    const id = await idParam(ctx.params);
    return NextResponse.json(await startCardPayment(id, session.userId));
});
