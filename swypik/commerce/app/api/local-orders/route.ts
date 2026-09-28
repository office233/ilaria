/**
 * Comenzi locale (food delivery) — plasare + listare.
 *
 * POST /api/local-orders — clientul plasează o comandă la un merchant.
 *   Prețurile se recalculează integral server-side din menu_items
 *   (inputul clientului conține doar id-uri + cantități).
 *   Totul rulează într-o tranzacție.
 *
 * GET /api/local-orders — comenzile clientului logat.
 */
import { NextResponse } from "next/server";
import { dbQuery, withTransaction } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { LocalOrderCreateSchemaRefined, parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";
import { isMerchantOrderable } from "@/lib/merchants/listing-mode";
import { maybeAutoDispatch } from "@/lib/dispatch/auto";
import { resolveDeliveryFee } from "@/lib/pricing/delivery";
import { haversineKm } from "@/lib/pricing/distance";
import { createLocalOrderPaymentIntent } from "@/lib/payments/eats-stripe";
import { isOpenNow, merchantTimezone } from "@/lib/merchants/hours";
import { etaMinutesForOrder } from "@/lib/food/config";
import { newGuestToken } from "@/lib/food/guest-token";
import { stripeConfigured } from "@/lib/payments/mobility-stripe";
import { validateOptionSelection, type MenuOption } from "@/lib/food/menu-options";
import { notifyMerchantNewOrder } from "@/lib/food/merchant-notify";
import { transitionOrder } from "@/lib/food/transition";
import { runTransitionEffects } from "@/lib/food/transition-effects";
import { DEFAULT_CURRENCY } from "@/lib/i18n/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


export async function POST(req: Request) {
    try {
        const session = await getAuthSession();
        const userId = session?.userId ?? null;

        const rl = await rateLimit("localOrders", userId ?? getClientIP(req));
        if (!rl.success) {
            return NextResponse.json({ success: false, error: "rate_limited", code: "rate_limited" }, { status: 429 });
        }

        const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        // Coordonatele livrării sunt obligatorii (audit food-go #8, #17).
        const lat = raw?.delivery_lat;
        const lng = raw?.delivery_lng;
        if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
            return NextResponse.json(
                { success: false, error: "delivery_location_required", code: "delivery_location_required" },
                { status: 400 },
            );
        }
        const parsed = parseBody(LocalOrderCreateSchemaRefined, raw);
        if (!parsed.ok) {
            // `error` stays the raw (mostly Romanian) zod message for back-compat;
            // `code` is additive so non-ro clients can show a translated generic
            // message instead (audit 2026-09-24, wave2-misc — see MenuClient.tsx).
            return NextResponse.json({ success: false, error: parsed.error, code: parsed.code }, { status: 400 });
        }
        const d = parsed.data;

        // Cardul doar când Stripe e configurat (cheile de prod pot lipsi) — audit #16.
        if (d.payment_method === "card_online" && !stripeConfigured()) {
            return NextResponse.json(
                { success: false, error: "payment_method_unavailable", code: "payment_method_unavailable" },
                { status: 422 },
            );
        }

        // Merchant activ + deschis
        const { rows: merchants } = await dbQuery(
            `SELECT id, name, status, min_order_cents, delivery_fee_cents, is_open_override, avg_prep_minutes,
                delivery_radius_km, location_city, location_country, location_lat, location_lng, listing_mode,
                opening_hours
         FROM local_merchants WHERE id = $1`,
            [d.merchant_id],
        );
        const merchant = merchants[0];
        if (!merchant || merchant.status !== "active") {
            return NextResponse.json({ success: false, code: "merchant_unavailable", error: "Restaurantul nu e disponibil." }, { status: 404 });
        }
        // Profilurile nerevendicate (ex. importate din OpenStreetMap) sunt doar
        // „sugerează proprietarului" — nu se poate comanda de la ele.
        if (!isMerchantOrderable(merchant)) {
            return NextResponse.json({ success: false, code: "merchant_not_orderable", error: "Restaurantul nu primește încă comenzi prin Swypik." }, { status: 409 });
        }
        // Program verificat și pe server (înainte doar clientul dezactiva butonul).
        if (!isOpenNow(merchant.opening_hours, merchant.is_open_override, new Date(), merchantTimezone(merchant.location_country))) {
            return NextResponse.json({ success: false, code: "merchant_closed", error: "Restaurantul este închis momentan." }, { status: 409 });
        }

        // Prețuri DIN DB, nu din client.
        interface MenuItemRow {
            id: string;
            name: string;
            price_cents: number;
            currency: string;
            options: MenuOption[] | null;
            is_available: boolean;
        }

        const itemIds = d.items.map((i) => i.menu_item_id);
        const { rows: menuItems } = await dbQuery<MenuItemRow>(
            `SELECT id, name, price_cents, currency, options, is_available
         FROM menu_items WHERE merchant_id = $1 AND id = ANY($2::uuid[])`,
            [d.merchant_id, itemIds],
        );
        const byId = new Map(menuItems.map((m) => [m.id, m]));

        let subtotal = 0;
        const orderItems: unknown[] = [];
        for (const item of d.items) {
            const mi = byId.get(item.menu_item_id);
            if (!mi || !mi.is_available) {
                return NextResponse.json(
                    { success: false, code: "item_unavailable", error: "Un produs din coș nu mai e disponibil.", menu_item_id: item.menu_item_id },
                    { status: 409 },
                );
            }
            // O singură monedă per comandă (audit #15).
            if ((mi.currency || DEFAULT_CURRENCY).trim().toUpperCase() !== DEFAULT_CURRENCY) {
                return NextResponse.json(
                    { success: false, code: "item_unavailable", error: "item_unavailable", menu_item_id: mi.id },
                    { status: 409 },
                );
            }
            // Opțiunile: existență + reguli required / max verificate pe server (audit #15).
            const sel = validateOptionSelection(mi.options ?? [], item.option_ids ?? []);
            if (!sel.ok) {
                return NextResponse.json(
                    { success: false, code: sel.code, error: sel.code, menu_item_id: mi.id, option: sel.option ?? null },
                    { status: 400 },
                );
            }
            const unit = mi.price_cents + sel.extra_cents;
            const chosenOptions = sel.chosen;
            subtotal += unit * item.qty;
            orderItems.push({
                menu_item_id: mi.id,
                name: mi.name,
                qty: item.qty,
                unit_price_cents: unit,
                options: chosenOptions,
                notes: item.notes ?? null,
            });
        }

        if (subtotal < (merchant.min_order_cents ?? 0)) {
            return NextResponse.json(
                {
                    success: false,
                    code: "below_min_order",
                    min_order_cents: merchant.min_order_cents ?? 0,
                    error: "below_min_order",
                },
                { status: 400 },
            );
        }

                // Taxă de livrare: dinamică (zonă + distanță + surge) cu fallback la fee fix.
                const feeResult = await resolveDeliveryFee({
                        merchant,
                        dropoff: { lat: d.delivery_lat ?? null, lng: d.delivery_lng ?? null },
                });
                const deliveryFee = feeResult.fee_cents;

        // Raza de livrare — refuzăm comenzile din afara ariei acoperite.
        const radiusKm = Number(merchant.delivery_radius_km ?? 0) || null;
        if (radiusKm != null && merchant.location_lat != null && merchant.location_lng != null) {
            const distKm =
                feeResult.distance_km ??
                haversineKm(
                    { lat: Number(merchant.location_lat), lng: Number(merchant.location_lng) },
                    { lat: d.delivery_lat, lng: d.delivery_lng },
                );
            if (distKm > radiusKm) {
                return NextResponse.json(
                    {
                        success: false,
                        error: "out_of_range",
                        code: "out_of_range",
                        radius_km: radiusKm,
                    },
                    { status: 400 },
                );
            }
        }

        const total = subtotal + deliveryFee + d.tip_cents;

        // Comenzile fără cont primesc un token de tracking (doar hash-ul în DB).
        const guest = userId ? null : newGuestToken();

        const order = await withTransaction(async (q) => {
            const { rows } = await q(
                `INSERT INTO local_orders (
           merchant_id, customer_user_id, customer_name, customer_phone,
           delivery_address, delivery_lat, delivery_lng, delivery_notes,
           items, subtotal_cents, delivery_fee_cents, tip_cents, total_cents,
                     payment_method, estimated_delivery_at,
                     delivery_distance_km, delivery_fee_breakdown, surge_multiplier, pricing_zone_id,
                     guest_token_hash
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9::jsonb, $10, $11, $12, $13, $14,
                     now() + make_interval(mins => $15),
                     $16, $17::jsonb, $18, $19, $20
         )
         RETURNING id, order_number, status, total_cents, currency, estimated_delivery_at`,
                [
                    d.merchant_id,
                    userId,
                    d.customer_name,
                    d.customer_phone,
                    d.delivery_address,
                    d.delivery_lat,
                    d.delivery_lng,
                    d.delivery_notes ?? null,
                    JSON.stringify(orderItems),
                    subtotal,
                    deliveryFee,
                    d.tip_cents,
                    total,
                    d.payment_method,
                    etaMinutesForOrder(merchant.avg_prep_minutes),
                    feeResult.distance_km,
                    feeResult.breakdown ? JSON.stringify(feeResult.breakdown) : null,
                    feeResult.surge_multiplier,
                    feeResult.zone_id,
                    guest?.hash ?? null,
                ],
            );
            return rows[0];
        });

        // Auto-dispatch la plasare, dacă merchantul are auto_dispatch_on='placed'.
        await maybeAutoDispatch(order.id, "placed");
        // Cash: restaurantul primește acum push-ul „comandă nouă"; cardul după autorizare.
        if (d.payment_method !== "card_online") await notifyMerchantNewOrder(order.id);

        // FRONT R5 — card online: PaymentIntent pe totalul calculat server-side.
        if (d.payment_method === "card_online") {
            try {
                const pay = await createLocalOrderPaymentIntent(order.id);
                return NextResponse.json({
                    success: true,
                    order,
                    tracking_token: guest?.token ?? null,
                    payment: pay
                        ? { client_secret: pay.client_secret, amount_cents: pay.amount_cents }
                        : null,
                });
            } catch (err) {
                // Stripe indisponibil (ex. chei placeholder): comanda NU rămâne „plasată
                // neplătită" la restaurant — o anulăm imediat (sistem) și spunem clientului.
                logger.error({ err, orderId: order.id }, "[local-orders] PI creation failed");
                const cancelled = await transitionOrder({
                    orderId: order.id,
                    to: "cancelled",
                    actor: "system",
                    reason: "payment_unavailable",
                    authorize: () => true,
                }).catch(() => null);
                if (cancelled?.ok) {
                    await runTransitionEffects({
                        orderId: order.id,
                        status: "cancelled",
                        customerUserId: cancelled.customerUserId,
                        merchantName: cancelled.merchantName,
                        reason: "payment_unavailable",
                        notifyCustomer: false,
                    }).catch(() => undefined);
                }
                return NextResponse.json(
                    { success: false, error: "card_unavailable", code: "card_unavailable" },
                    { status: 503 },
                );
            }
        }

        return NextResponse.json({ success: true, order, tracking_token: guest?.token ?? null });
    } catch (error: unknown) {
        logger.error({ err: error }, "[local-orders] POST error");
        return NextResponse.json({ success: false, error: "server_error", code: "server_error" }, { status: 500 });
    }
}

export async function GET(req: Request) {
    try {
        const session = await getAuthSession();
        if (!session?.userId) {
            return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }
        const url = new URL(req.url);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);

        const { rows } = await dbQuery(
            `SELECT lo.id, lo.order_number, lo.status, lo.items, lo.total_cents, lo.currency,
              lo.payment_method, lo.payment_status, lo.refund_status, lo.placed_at, lo.estimated_delivery_at,
                            m.name AS merchant_name, m.slug AS merchant_slug, m.image_url AS merchant_image,
              c.full_name AS courier_name,
              -- Poziția curierului doar cât livrarea e în curs (audit food-go #9).
              CASE WHEN lo.status IN ('picked_up', 'delivering') THEN c.current_lat END AS courier_lat,
              CASE WHEN lo.status IN ('picked_up', 'delivering') THEN c.current_lng END AS courier_lng
         FROM local_orders lo
         JOIN local_merchants m ON m.id = lo.merchant_id
         LEFT JOIN couriers c ON c.id = lo.courier_id
        WHERE lo.customer_user_id = $1
        ORDER BY lo.placed_at DESC
        LIMIT $2`,
            [session.userId, limit],
        );
        return NextResponse.json({ success: true, orders: rows });
    } catch (error: unknown) {
        logger.error({ err: error }, "[local-orders] GET error");
        return NextResponse.json({ success: false, error: "server_error", code: "server_error" }, { status: 500 });
    }
}
