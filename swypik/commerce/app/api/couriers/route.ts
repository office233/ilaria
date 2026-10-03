/**
 * Curieri & șoferi — înrolare și profil.
 *
 * POST /api/couriers  → aplicație de înrolare (cont obligatoriu, rate-limited).
 * GET  /api/couriers  → profilul curierului logat.
 * PATCH /api/couriers → actualizare profil. Documentele se încarcă prin
 *                       POST /api/couriers/documents (storage + revizie admin).
 *
 * Audit food-go: #6 aplicațiile fără cont (user_id NULL) nu se legau niciodată
 * de un cont → acum 401 login_required; #4 schimbarea vehiculului / numărului /
 * orașului unui curier aprobat îl trimite înapoi la verificare.
 */
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { dbQuery } from "@/lib/db";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { getAuthSession } from "@/lib/auth/session";
import { CourierApplySchema, CourierUpdateSchema, parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";
import { sendOpsApplicationAlert } from "@/lib/email/templates/ops";
import { VEHICLE_DOCUMENT_TYPES } from "@/lib/fleet/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ipHash(req: Request): string {
    const ip = getClientIP(req);
    return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

const PUBLIC_COLS = `
  id, kind, full_name, phone, email, vehicle_type, vehicle_plate,
  city, country, verification_status, is_online, rating,
  completed_deliveries, created_at
`;

export async function POST(req: Request) {
    try {
        const rl = await rateLimit("courierApply", ipHash(req));
        if (!rl.success) {
            return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
        }

        const session = await getAuthSession();
        const userId = session?.userId ?? null;
        if (!userId) {
            return NextResponse.json({ success: false, error: "login_required", code: "login_required" }, { status: 401 });
        }

        const raw = await req.json().catch(() => null);
        const parsed = parseBody(CourierApplySchema, raw);
        if (!parsed.ok) {
            return NextResponse.json({ success: false, error: parsed.error, code: parsed.code }, { status: 400 });
        }
        const d = parsed.data;

        // Un user poate avea o singură aplicație de curier.
        const { rows: existing } = await dbQuery(
            `SELECT id, verification_status FROM couriers WHERE user_id = $1`,
            [userId],
        );
        if (existing.length) {
            return NextResponse.json(
                { success: false, error: "already_applied", code: "already_applied", status: existing[0].verification_status },
                { status: 409 },
            );
        }

        const { rows } = await dbQuery(
            `INSERT INTO couriers (
         user_id, kind, full_name, phone, email,
         vehicle_type, vehicle_plate, city, country, documents
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING ${PUBLIC_COLS}`,
            [
                userId,
                d.kind,
                d.full_name,
                d.phone,
                d.email ?? null,
                d.vehicle_type,
                d.vehicle_plate ?? null,
                d.city,
                d.country,
                JSON.stringify(d.documents ?? {}),
            ],
        );

        // Notifică ops: aplicație nouă de verificat (best-effort; escaparea e în lib/email).
        sendOpsApplicationAlert({
            kind: d.kind === "driver" ? "driver" : "courier",
            label: d.full_name,
            fields: {
                name: d.full_name,
                phone: d.phone,
                email: d.email ?? null,
                city: d.city,
                vehicle: d.vehicle_plate ? `${d.vehicle_type} (${d.vehicle_plate})` : d.vehicle_type,
            },
            adminPath: "/admin/fleet",
        }).catch((err) => logger.warn({ err }, "[couriers] ops email failed"));

        return NextResponse.json({ success: true, courier: rows[0] });
    } catch (error: unknown) {
        logger.error({ err: error }, "[couriers] POST error");
        return NextResponse.json({ success: false, error: "server_error", code: "server_error" }, { status: 500 });
    }
}

export async function GET() {
    try {
        const session = await getAuthSession();
        if (!session?.userId) {
            return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }
        const { rows } = await dbQuery(
            `SELECT ${PUBLIC_COLS} FROM couriers WHERE user_id = $1 AND deleted_at IS NULL`,
            [session.userId],
        );
        if (!rows.length) {
            return NextResponse.json({ success: true, courier: null });
        }
        return NextResponse.json({ success: true, courier: rows[0] });
    } catch (error: unknown) {
        logger.error({ err: error }, "[couriers] GET error");
        return NextResponse.json({ success: false, error: "Eroare." }, { status: 500 });
    }
}

export async function PATCH(req: Request) {
    try {
        const session = await getAuthSession();
        if (!session?.userId) {
            return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }

        const raw = await req.json().catch(() => null);
        const parsed = parseBody(CourierUpdateSchema, raw);
        if (!parsed.ok) {
            return NextResponse.json({ success: false, error: parsed.error, code: parsed.code }, { status: 400 });
        }
        const d = parsed.data;

        const sets: string[] = [];
        const params: unknown[] = [session.userId];
        const push = (col: string, val: unknown) => {
            params.push(val);
            sets.push(`${col} = $${params.length}`);
        };

        if (d.phone !== undefined) push("phone", d.phone);
        if (d.email !== undefined) push("email", d.email);
        if (d.vehicle_type !== undefined) push("vehicle_type", d.vehicle_type);
        if (d.vehicle_plate !== undefined) push("vehicle_plate", d.vehicle_plate);
        if (d.city !== undefined) push("city", d.city);
        if (d.documents !== undefined) {
            // Documentele nu se mai scriu în jsonb-ul vechi: upload + revizie prin
            // POST /api/couriers/documents (audit food-go #3).
            return NextResponse.json({ success: false, error: "use_documents_upload", code: "use_documents_upload" }, { status: 400 });
        }
        if (!sets.length) {
            return NextResponse.json({ success: false, error: "nothing_to_update", code: "nothing_to_update" }, { status: 400 });
        }

        const { rows: cur } = await dbQuery<{ id: string; verification_status: string; vehicle_type: string; vehicle_plate: string | null; city: string }>(
            `SELECT id, verification_status, vehicle_type, vehicle_plate, city FROM couriers WHERE user_id = $1 AND deleted_at IS NULL`,
            [session.userId],
        );
        const current = cur[0];
        if (!current) {
            return NextResponse.json({ success: false, error: "not_a_courier", code: "not_a_courier" }, { status: 404 });
        }
        // Vehicul / număr / oraș schimbat după aprobare → înapoi la verificare,
        // offline, iar documentele vehiculului trebuie re-aprobate (audit #4).
        const norm = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, "").toUpperCase();
        const vehicleChanged =
            (d.vehicle_type !== undefined && d.vehicle_type !== current.vehicle_type) ||
            (d.vehicle_plate !== undefined && norm(d.vehicle_plate) !== norm(current.vehicle_plate));
        const cityChanged = d.city !== undefined && d.city.trim().toLowerCase() !== current.city.trim().toLowerCase();
        const recheck = current.verification_status === "approved" && (vehicleChanged || cityChanged);
        if (recheck) sets.push("verification_status = 'in_review'", "is_online = false");
        sets.push("updated_at = now()");

        const { rows } = await dbQuery(
            `UPDATE couriers SET ${sets.join(", ")} WHERE user_id = $1 AND deleted_at IS NULL RETURNING ${PUBLIC_COLS}`,
            params,
        );
        if (!rows.length) {
            return NextResponse.json({ success: false, error: "not_a_courier", code: "not_a_courier" }, { status: 404 });
        }
        if (recheck && vehicleChanged) {
            await dbQuery(
                `UPDATE courier_documents SET status = 'pending', reviewed_at = NULL, updated_at = now()
                  WHERE courier_id = $1 AND doc_type = ANY($2::text[])`,
                [current.id, VEHICLE_DOCUMENT_TYPES],
            );
        }
        return NextResponse.json({ success: true, courier: rows[0], reverification: recheck });
    } catch (error: unknown) {
        logger.error({ err: error }, "[couriers] PATCH error");
        return NextResponse.json({ success: false, error: "server_error", code: "server_error" }, { status: 500 });
    }
}
