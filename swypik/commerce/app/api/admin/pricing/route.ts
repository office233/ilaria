/**
 * Admin Pricing — listare + editare zone și surge manual.
 *
 * GET  /api/admin/pricing            → zone + reguli surge active
 * POST /api/admin/pricing            → { action: 'upsert_zone' | 'update_zone' | 'toggle_zone' | 'add_surge' | 'end_surge', ... }
 *
 * Protejat: requireAdmin(req, "mobility") — sesiune admin cu rol ops/owner sau Bearer ADMIN_SECRET.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/security/admin-audit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger.child({ route: "/api/admin/pricing" });


const ZoneSchema = z.object({
  city: z.string().trim().min(2).max(120),
  country: z.string().trim().length(2).toUpperCase().default("RO"),
  kind: z.enum(["delivery", "ride", "errand"]),
  vehicle_class: z.enum(["economy", "comfort", "van", "bike"]).default("economy"),
  base_cents: z.number().int().min(0),
  per_km_cents: z.number().int().min(0),
  per_min_cents: z.number().int().min(0).default(0),
  min_fare_cents: z.number().int().min(0).default(0),
  booking_fee_cents: z.number().int().min(0).default(0),
  cancel_fee_cents: z.number().int().min(0).default(0),
  platform_commission_pct: z.number().min(0).max(100).default(20),
  courier_share_pct: z.number().min(0).max(100).default(80),
  currency: z.string().trim().length(3).toUpperCase().default("RON"),
  max_passengers: z.number().int().min(1).max(20).nullable().optional(),
});

const ActionSchema = z.discriminatedUnion("action", [
  ZoneSchema.extend({ action: z.literal("upsert_zone") }),
  z.object({ action: z.literal("update_zone"), id: z.string().uuid(), patch: ZoneSchema.partial() }),
  z.object({ action: z.literal("toggle_zone"), id: z.string().uuid(), active: z.boolean() }),
  z.object({
    action: z.literal("add_surge"),
    zone_id: z.string().uuid(),
    multiplier: z.number().min(1).max(2),
    ends_at: z.string().datetime().nullable().optional(),
  }),
  z.object({ action: z.literal("end_surge"), id: z.string().uuid() }),
]);

export async function GET(req: Request) {
  const actor = await requireAdmin(req, "mobility");
  if (actor instanceof NextResponse) return actor;
  const [zones, surges] = await Promise.all([
    dbQuery(
      `SELECT * FROM pricing_zones ORDER BY country, lower(city), kind, vehicle_class`,
    ),
    dbQuery(
      `SELECT sr.*, pz.city, pz.kind, pz.vehicle_class
         FROM surge_rules sr JOIN pricing_zones pz ON pz.id = sr.zone_id
        WHERE sr.ends_at IS NULL OR sr.ends_at > now()
        ORDER BY sr.starts_at DESC LIMIT 100`,
    ),
  ]);
  return NextResponse.json({ zones: zones.rows, surges: surges.rows });
}

export async function POST(req: Request) {
  const actor = await requireAdmin(req, "mobility");
  if (actor instanceof NextResponse) return actor;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const data = parsed.data;

  try {
    switch (data.action) {
      case "upsert_zone": {
        const z_ = data;
        const { rows } = await dbQuery(
          `INSERT INTO pricing_zones
             (city, country, kind, vehicle_class, base_cents, per_km_cents, per_min_cents,
              min_fare_cents, booking_fee_cents, cancel_fee_cents,
              platform_commission_pct, courier_share_pct, currency, max_passengers, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)
           RETURNING id`,
          [
            z_.city, z_.country, z_.kind, z_.vehicle_class, z_.base_cents,
            z_.per_km_cents, z_.per_min_cents, z_.min_fare_cents,
            z_.booking_fee_cents, z_.cancel_fee_cents,
            z_.platform_commission_pct, z_.courier_share_pct, z_.currency, z_.max_passengers ?? null,
          ],
        );
        await logAdminAction({
          actor,
          action: "pricing.upsert_zone",
          targetType: "pricing_zone",
          targetId: rows[0].id,
          details: { city: z_.city, kind: z_.kind, vehicle_class: z_.vehicle_class },
          req,
        });
        return NextResponse.json({ ok: true, id: rows[0].id });
      }
      case "update_zone": {
        const allowed = ZoneSchema.partial().parse(data.patch);
        const keys = Object.keys(allowed) as Array<keyof typeof allowed>;
        if (keys.length === 0) return NextResponse.json({ error: "empty_patch" }, { status: 400 });
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
        await dbQuery(
          `UPDATE pricing_zones SET ${sets} WHERE id = $1`,
          [data.id, ...keys.map((k) => allowed[k])],
        );
        await logAdminAction({
          actor,
          action: "pricing.update_zone",
          targetType: "pricing_zone",
          targetId: data.id,
          details: { fields: keys, values: allowed },
          req,
        });
        return NextResponse.json({ ok: true });
      }
      case "toggle_zone": {
        await dbQuery(`UPDATE pricing_zones SET active = $2 WHERE id = $1`, [
          data.id,
          data.active,
        ]);
        await logAdminAction({
          actor,
          action: "pricing.toggle_zone",
          targetType: "pricing_zone",
          targetId: data.id,
          details: { active: data.active },
          req,
        });
        return NextResponse.json({ ok: true });
      }
      case "add_surge": {
        const { rows } = await dbQuery(
          `INSERT INTO surge_rules (zone_id, multiplier, ends_at, auto)
           VALUES ($1, $2, $3, false) RETURNING id`,
          [data.zone_id, data.multiplier, data.ends_at ?? null],
        );
        await logAdminAction({
          actor,
          action: "pricing.add_surge",
          targetType: "surge_rule",
          targetId: rows[0].id,
          details: { zoneId: data.zone_id, multiplier: data.multiplier, endsAt: data.ends_at ?? null },
          req,
        });
        return NextResponse.json({ ok: true, id: rows[0].id });
      }
      case "end_surge": {
        await dbQuery(`UPDATE surge_rules SET ends_at = now() WHERE id = $1`, [data.id]);
        await logAdminAction({
          actor,
          action: "pricing.end_surge",
          targetType: "surge_rule",
          targetId: data.id,
          req,
        });
        return NextResponse.json({ ok: true });
      }
    }
  } catch (err) {
    log.error({ err }, "admin pricing action failed");
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
