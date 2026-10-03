/**
 * GET /api/me/activity — flux unificat de activitate al clientului:
 * comenzile Eats (local_orders) + cursele Go (rides) + comenzile Shop
 * (commerce_orders), într-o singură listă cronologică (desc).
 * Paginat cu ?page=1&limit=20.
 *
 * Răspuns: { success, items: ActivityItem[], page, limit, has_more }
 *   ActivityItem = {
 *     kind: "food_order" | "ride" | "shop_order",
 *     id, status, ts (ISO), total_cents, currency,
 *     title (nume restaurant / adresă destinație),
 *     subtitle (nr. comandă / adresă pickup),
 *     href (link către tracking-ul potrivit)
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

type ActivityRow = {
  kind: "food_order" | "ride" | "shop_order";
  id: string;
  status: string;
  ts: string;
  total_cents: number | null;
  currency: string;
  title: string;
  subtitle: string;
};

export async function GET(req: NextRequest) {
  const user = await getAuthUser();
  if (!user.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(sp.get("limit") ?? "20", 10) || 20));
  const offset = (page - 1) * limit;

  try {
    // Cerem limit+1 rânduri ca să știm dacă mai există pagină următoare.
    const { rows } = await dbQuery<ActivityRow>(
      `
      SELECT * FROM (
        SELECT
          'food_order'::text            AS kind,
          lo.id::text                   AS id,
          lo.status                     AS status,
          lo.placed_at                  AS ts,
          lo.total_cents                AS total_cents,
          lo.currency::text             AS currency,
          lm.name                       AS title,
          ('#' || lo.order_number)      AS subtitle
        FROM local_orders lo
        JOIN local_merchants lm ON lm.id = lo.merchant_id
        WHERE lo.customer_user_id = $1

        UNION ALL

        SELECT
          'ride'::text                                    AS kind,
          r.id::text                                      AS id,
          r.status                                        AS status,
          r.requested_at                                  AS ts,
          COALESCE(r.final_fare_cents, r.estimated_fare_cents) AS total_cents,
          r.currency::text                                AS currency,
          r.dropoff_address                               AS title,
          r.pickup_address                                AS subtitle
        FROM rides r
        WHERE r.rider_user_id = $1

        UNION ALL

        SELECT
          'shop_order'::text                              AS kind,
          co.id::text                                     AS id,
          co.status                                       AS status,
          COALESCE(co.placed_at, co.created_at)           AS ts,
          co.total_cents                                  AS total_cents,
          co.currency::text                               AS currency,
          COALESCE(
            (SELECT string_agg(coi.title, ', ' ORDER BY coi.created_at)
               FROM (SELECT title, created_at FROM commerce_order_items
                      WHERE order_id = co.id LIMIT 3) coi),
            'Comandă produse'
          )                                               AS title,
          ('#' || left(co.id::text, 8))                   AS subtitle
        FROM commerce_orders co
        WHERE co.buyer_user_id = $1
          AND co.status <> 'pending'
      ) activity
      ORDER BY ts DESC
      LIMIT $2 OFFSET $3
      `,
      [user.userId, limit + 1, offset],
    );

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => ({
      ...r,
      ts: new Date(r.ts).toISOString(),
      href:
        r.kind === "food_order"
          ? `/food/orders/${r.id}`
          : r.kind === "shop_order"
            ? `/account/orders/${r.id}`
            : `/go/${r.id}`,
    }));

    return NextResponse.json({ success: true, items, page, limit, has_more: hasMore });
  } catch (err) {
    logger.error({ err }, "[me/activity] query failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
