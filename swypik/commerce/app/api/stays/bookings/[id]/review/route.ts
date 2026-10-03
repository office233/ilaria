/**
 * POST /api/stays/bookings/[id]/review { rating 1–5, comment? } — recenzie
 * după sejur (doar clientul rezervării, o dată, după check-out).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { staysError } from "@/lib/stays/errors";
import { createReview } from "@/lib/stays/reviews";
import { idParam, limitOrThrow, requireSession, staysRoute } from "@/lib/stays/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(2000).optional(),
});

export const POST = staysRoute("stays/bookings/review", async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession();
    await limitOrThrow(req, "review", session.userId, { limit: 10, window: 3600 });
    const id = await idParam(ctx.params);
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return staysError("invalid_input");
    const reviewId = await createReview(id, session.userId, parsed.data.rating, parsed.data.comment || null);
    return NextResponse.json({ ok: true, reviewId });
});
