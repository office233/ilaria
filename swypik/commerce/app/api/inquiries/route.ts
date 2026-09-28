/**
 * Universal Marketplace — Inquiries (lead-uri pe anunțuri)
 *
 * POST /api/inquiries — formularul „Contactează vânzătorul" de pe un anunț.
 *   Public (nu cere login), dar rate-limited pe IP + honeypot anti-spam.
 * GET  /api/inquiries — vânzătorul își vede lead-urile (auth seller).
 */
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { InquiryCreateSchema, parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientIpHash(req: Request): string {
    const ip =
        req.headers.get("cf-connecting-ip") ||
        req.headers.get("x-real-ip") ||
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        "unknown";
    return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

export async function POST(req: Request) {
    try {
        const ipHash = clientIpHash(req);
        const rl = await rateLimit("inquiries", ipHash);
        if (!rl.success) {
            return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
        }

        const raw = await req.json().catch(() => null);

        // Honeypot: câmp invizibil în formular — dacă e completat, e bot.
        if (raw && typeof raw === "object" && (raw as Record<string, unknown>).website) {
            return NextResponse.json({ success: true }); // răspuns fals-pozitiv pentru bot
        }

        const parsed = parseBody(InquiryCreateSchema, raw);
        if (!parsed.ok) {
            return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
        }
        const d = parsed.data;

        // Anunțul trebuie să existe, să fie activ și de tip listing.
        const { rows: products } = await dbQuery(
            `SELECT id FROM marketplace_products
        WHERE id = $1 AND status = 'active' AND listing_type = 'listing'`,
            [d.product_id],
        );
        if (!products.length) {
            return NextResponse.json({ success: false, error: "Anunțul nu există." }, { status: 404 });
        }

        // Max 3 inquiries per IP per anunț (anti-spam suplimentar).
        const { rows: dupes } = await dbQuery(
            `SELECT count(*)::int AS n FROM inquiry_requests
        WHERE product_id = $1 AND ip_hash = $2 AND created_at > now() - interval '1 day'`,
            [d.product_id, ipHash],
        );
        if ((dupes[0]?.n ?? 0) >= 3) {
            return NextResponse.json({ success: false, error: "Prea multe mesaje pentru acest anunț." }, { status: 429 });
        }

        const { rows } = await dbQuery(
            `INSERT INTO inquiry_requests (product_id, name, email, phone, message, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
            [d.product_id, d.name, d.email ?? null, d.phone ?? null, d.message, ipHash],
        );

        return NextResponse.json({ success: true, inquiry_id: rows[0]?.id });
    } catch (error: unknown) {
        logger.error({ err: error }, "[inquiries] POST error");
        return NextResponse.json({ success: false, error: "Eroare la trimiterea mesajului." }, { status: 500 });
    }
}

export async function GET(req: Request) {
    try {
        const sellerId = await getSellerSessionId();
        if (!sellerId) {
            return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }

        const url = new URL(req.url);
        const status = url.searchParams.get("status");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);

        const params: unknown[] = [sellerId];
        let statusFilter = "";
        if (status && ["new", "contacted", "closed", "spam"].includes(status)) {
            params.push(status);
            statusFilter = `AND i.status = $${params.length}`;
        }
        params.push(limit);

        const { rows } = await dbQuery(
            `SELECT i.id, i.product_id, p.title AS product_title, p.slug AS product_slug,
              i.name, i.email, i.phone, i.message, i.status, i.created_at
         FROM inquiry_requests i
         JOIN marketplace_products p ON p.id = i.product_id
        WHERE p.seller_id = $1 ${statusFilter}
        ORDER BY i.created_at DESC
        LIMIT $${params.length}`,
            params,
        );

        return NextResponse.json({ success: true, inquiries: rows });
    } catch (error: unknown) {
        logger.error({ err: error }, "[inquiries] GET error");
        return NextResponse.json({ success: false, error: "Eroare la încărcarea lead-urilor." }, { status: 500 });
    }
}
