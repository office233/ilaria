import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { MAX_LIKED_IDS, parseLikedIds } from "@/lib/feed/liked-ids";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/feed/offers/liked?ids=a,b,c — ce a dat viewerul like, din setul cerut.
 *
 * DE CE EXISTĂ RUTA ASTA
 * Homepage-ul (`app/[locale]/page.tsx`) își construiește secțiunile printr-un
 * `unstable_cache` cu cheie GLOBALĂ ("home-product-sections-v2", revalidate 120).
 * Un cache global nu are voie să conțină date per-utilizator: primul vizitator
 * ar fixa starea de like pentru toți ceilalți timp de două minute. De aceea
 * `viewerLiked` e hardcodat `false` acolo — corect, dar incomplet: la refresh
 * toate inimile reveneau la gri, deși like-ul era salvat în DB.
 *
 * Ruta asta închide golul: pagina se servește din cache-ul global (rapid, comun
 * tuturor), iar starea personală se cere separat, după montare.
 *
 * DE CE NU AM REFOLOSIT `/api/feed/offers`
 * Ruta aceea calculează deja `likedSet` (route.ts:91-99), dar numai pentru
 * produsele pe care le alege EA, prin `searchProducts`. Nu acceptă o listă de
 * id-uri din exterior. Ca s-o refolosim ar fi trebuit fie să-i schimbăm
 * contractul, fie să reexecutăm o căutare întreagă doar ca să aflăm câteva
 * booleene. Aici facem un singur SELECT pe cheia primară.
 */
export async function GET(request: Request) {
    try {
        const raw = new URL(request.url).searchParams.get("ids") ?? "";
        const parsed = parseLikedIds(raw);
        if (!parsed.ok) {
            return NextResponse.json(
                parsed.error === "too_many_ids"
                    ? { error: "too_many_ids", max: MAX_LIKED_IDS }
                    : { error: "invalid_id" },
                { status: 400 },
            );
        }
        const { ids } = parsed;
        if (!ids.length) return NextResponse.json({ liked: [] });

        // Vizitator fără sesiune: nu are cum să fi dat like. Răspundem cu listă
        // goală, nu 401 — pagina e publică, iar un 401 ar polua consola și ar
        // face clientul să creadă că e o eroare reală.
        const viewerId = await getOptionalSocialUserId();
        if (!viewerId) return NextResponse.json({ liked: [] });

        const rl = await rateLimit("products", viewerId);
        if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

        // Aceeași interogare ca în `/api/feed/offers` (route.ts:93-96), ca cele
        // două căi să nu poată diverge în ce consideră „liked".
        const { rows } = await dbQuery<{ product_id: string }>(
            `SELECT product_id FROM likes WHERE user_id = $1 AND product_id = ANY($2::uuid[])`,
            [viewerId, ids],
        );

        return NextResponse.json({ liked: rows.map((r) => String(r.product_id)) });
    } catch (error) {
        logger.error({ error: String(error) }, "offers liked lookup failed");
        return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
}
