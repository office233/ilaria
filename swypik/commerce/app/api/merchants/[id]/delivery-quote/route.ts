/**
 * GET /api/merchants/[id]/delivery-quote?lat=&lng=
 *
 * Estimarea taxei de livrare ÎNAINTE de plasarea comenzii (checkout UI).
 * Folosește exact aceeași logică server-side ca POST /api/local-orders
 * (lib/pricing/delivery.ts), deci suma afișată = suma facturată.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { resolveDeliveryFee } from "@/lib/pricing/delivery";
import { haversineKm } from "@/lib/pricing/distance";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        if (!UUID_RE.test(id)) {
            return NextResponse.json({ success: false, error: "invalid_id", code: "invalid_id" }, { status: 400 });
        }
        const ip = getClientIP(req);
        const rl = await rateLimit("deliveryQuote", ip, { limit: 60, window: 60 });
        if (!rl.success) {
            return NextResponse.json({ success: false, error: "rate_limited", code: "rate_limited" }, { status: 429 });
        }

        const url = new URL(req.url);
        // Number(null) = 0 → un quote fără coordonate era calculat pentru (0,0) și
        // ieșea „out_of_range" (audit food-go #17). Parametrii lipsă = fără coordonate.
        const latRaw = url.searchParams.get("lat");
        const lngRaw = url.searchParams.get("lng");
        const lat = latRaw ? Number(latRaw) : NaN;
        const lng = lngRaw ? Number(lngRaw) : NaN;
        const hasCoords =
            Number.isFinite(lat) && Number.isFinite(lng) &&
            Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

        const { rows } = await dbQuery(
            `SELECT delivery_fee_cents, min_order_cents, avg_prep_minutes,
                            delivery_radius_km, location_city, location_country, location_lat, location_lng
         FROM local_merchants WHERE id = $1 AND status = 'active'`,
            [id],
        );
        const merchant = rows[0];
        if (!merchant) {
            return NextResponse.json({ success: false, error: "not_found", code: "not_found" }, { status: 404 });
        }

        const quote = await resolveDeliveryFee({
            merchant,
            dropoff: hasCoords ? { lat, lng } : { lat: null, lng: null },
        });

        // Raza de livrare — verificată doar dacă avem ambele coordonate.
        const radiusKm = Number(merchant.delivery_radius_km ?? 0) || null;
        const distanceKm =
            quote.distance_km ??
            (hasCoords && merchant.location_lat != null && merchant.location_lng != null
                ? haversineKm(
                      { lat: Number(merchant.location_lat), lng: Number(merchant.location_lng) },
                      { lat, lng },
                  )
                : null);
        const outOfRange = radiusKm != null && distanceKm != null && distanceKm > radiusKm;

        return NextResponse.json({
            success: true,
            quote: {
                fee_cents: quote.fee_cents,
                source: quote.source,
                distance_km: distanceKm,
                surge_multiplier: quote.surge_multiplier,
                min_order_cents: merchant.min_order_cents,
                avg_prep_minutes: merchant.avg_prep_minutes,
                delivery_radius_km: radiusKm,
                out_of_range: outOfRange,
                has_location: hasCoords,
            },
        });
    } catch (error: unknown) {
        logger.error({ err: error }, "[delivery-quote] GET error");
        return NextResponse.json({ success: false, error: "server_error", code: "server_error" }, { status: 500 });
    }
}
