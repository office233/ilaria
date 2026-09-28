/**
 * POST /api/stays/bookings/[id]/pay — plata din wallet (metodă secundară).
 * Suma se debitează acum; rezervarea devine 'requested' (gazda acceptă sau
 * refuză). La refuz/expirare banii se întorc automat în wallet.
 */
import { NextResponse } from "next/server";
import { payWithWallet } from "@/lib/stays/payment";
import { idParam, limitOrThrow, requireSession, staysRoute } from "@/lib/stays/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = staysRoute("stays/bookings/pay", async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession();
    await limitOrThrow(req, "pay", session.userId, { limit: 10, window: 600 });
    const id = await idParam(ctx.params);
    return NextResponse.json({ ok: true, ...(await payWithWallet(id, session.userId)) });
});
