/**
 * Francize de flotă.
 * POST /api/fleet-partners → aplicație publică (rate-limited); notifică admin.
 * GET  /api/fleet-partners → profilul francizei userului logat + șoferii ei.
 */
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { getAuthSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { sendOpsApplicationAlert } from "@/lib/email/templates/ops";

export const dynamic = "force-dynamic";

const FleetPartnerApplySchema = z.object({
    company_name: z.string().trim().min(3).max(160),
    cui: z.string().trim().max(32).optional(),
    contact_name: z.string().trim().min(3).max(120),
    phone: z.string().trim().min(5).max(32),
    email: z.string().trim().email().max(254).optional(),
    city: z.string().trim().min(2).max(80),
    vertical: z.enum(["go", "food", "both"]).default("both"),
});

function ipHash(req: Request): string {
    const ip = getClientIP(req);
    return createHash("sha256").update(ip).digest("hex").slice(0, 24);
}

export async function POST(req: Request) {
    try {
        const rl = await rateLimit("courierApply", ipHash(req));
        if (!rl.success) return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });

        const raw = await req.json().catch(() => null);
        const parsed = FleetPartnerApplySchema.safeParse(raw);
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: "Date invalide" }, { status: 400 });
        }
        const d = parsed.data;

        const session = await getAuthSession();
        const userId = session?.userId ?? null;

        const { rows } = await dbQuery(
            `INSERT INTO fleet_partners (user_id, company_name, cui, contact_name, phone, email, city, vertical)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, company_name, city, vertical, status`,
            [userId, d.company_name, d.cui ?? null, d.contact_name, d.phone, d.email ?? null, d.city, d.vertical]
        );

        // Notifică ops (best-effort; escaparea e în lib/email).
        sendOpsApplicationAlert({
            kind: "fleetPartner",
            label: d.company_name,
            fields: {
                company: d.company_name,
                cui: d.cui ?? null,
                name: d.contact_name,
                phone: d.phone,
                email: d.email ?? null,
                city: d.city,
                vertical: d.vertical,
            },
            adminPath: "/admin/fleet",
        }).catch((err) => logger.warn({ err }, "[fleet-partners] ops email failed"));

        return NextResponse.json({ success: true, partner: rows[0] });
    } catch (error) {
        logger.error({ err: error }, "[fleet-partners] POST error");
        return NextResponse.json({ success: false, error: "internal_error" }, { status: 500 });
    }
}

export async function GET() {
    try {
        const session = await getAuthSession();
        if (!session?.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

        const { rows: partners } = await dbQuery(
            `SELECT id, company_name, cui, contact_name, phone, email, city, vertical, status, commission_bps
         FROM fleet_partners WHERE user_id = $1 LIMIT 1`,
            [session.userId]
        );
        if (!partners.length) return NextResponse.json({ partner: null, drivers: [] });
        const partner = partners[0];

        const { rows: drivers } = await dbQuery(
            `SELECT id, kind, full_name, phone, city, vehicle_type, vehicle_plate,
              verification_status, active, created_at
         FROM couriers WHERE fleet_partner_id = $1
        ORDER BY created_at DESC LIMIT 200`,
            [partner.id]
        );

        // Statistici pe flota francizei (best-effort; tabelele pot lipsi in dev).
        let stats = { rides_30d: 0, revenue_30d_cents: 0, commission_30d_cents: 0 };
        try {
            const { rows: statRows } = await dbQuery<{ rides: string; revenue: string }>(
                `SELECT COUNT(*)::int AS rides,
                        COALESCE(SUM(COALESCE(r.final_fare_cents, r.estimated_fare_cents)), 0)::bigint AS revenue
                   FROM rides r
                   JOIN couriers c ON c.id = r.driver_id
                  WHERE c.fleet_partner_id = $1
                    AND r.status = 'completed'
                    AND r.requested_at > now() - interval '30 days'`,
                [partner.id]
            );
            const revenue = Number(statRows[0]?.revenue ?? 0);
            stats = {
                rides_30d: Number(statRows[0]?.rides ?? 0),
                revenue_30d_cents: revenue,
                commission_30d_cents: Math.round((revenue * (partner.commission_bps ?? 0)) / 10000),
            };
        } catch (err) {
            logger.warn({ err }, "[fleet-partners] stats query failed");
        }

        return NextResponse.json({ partner, drivers, stats });
    } catch (error) {
        logger.error({ err: error }, "[fleet-partners] GET error");
        return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
}
