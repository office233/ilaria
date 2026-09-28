/**
 * POST /api/fly/price-check — Live Price Check.
 * Se apelează OBLIGATORIU înainte de butonul final de plată: revalidează
 * prețul la furnizor (<1s) și actualizează cache-ul ofertei.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { priceCheck } from "@/lib/fly/service";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { logger } from "@/lib/logger";
import { flyBookingGuard } from "@/lib/fly/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ token: z.string().uuid() });

export async function POST(req: Request) {
    const closed = flyBookingGuard();
    if (closed) return closed;
    const rl = await rateLimit("fly:price", getClientIP(req), { limit: 60, window: 60 });
    if (!rl.success) return NextResponse.json({ error: "rate limited" }, { status: 429 });

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "token invalid" }, { status: 400 });

    try {
        const result = await priceCheck(parsed.data.token);
        if (!result.ok) {
            return NextResponse.json(
                { ok: false, reason: result.reason ?? "unavailable", message: "Oferta nu mai e disponibilă. Reia căutarea." },
                { status: 409 },
            );
        }
        return NextResponse.json({
            ok: true,
            token: result.token,
            totalCents: result.offer!.totalCents,
            currency: result.offer!.currency,
            deltaCents: result.deltaCents ?? 0,
            priceChanged: (result.deltaCents ?? 0) !== 0,
        });
    } catch (err) {
        logger.error({ err, route: "/api/fly/price-check" }, "fly price check failed");
        return NextResponse.json({ error: "Verificarea prețului a eșuat" }, { status: 502 });
    }
}
