/**
 * PATCH /api/admin/fleet/[id] — verificarea aplicațiilor de flotă (șoferi Go, curieri Food).
 * Body: { action: "approve" | "reject" | "suspend" | "reactivate" | "delete", fleet_partner_id? }
 *
 *  - permisiunea `mobility` (RBAC; înainte orice sesiune de admin, audit food-go #5);
 *  - approve: refuzat cu 409 `documents_missing` dacă documentele obligatorii nu
 *    sunt aprobate și neexpirate (audit #2);
 *  - delete: ștergere logică (deleted_at) — cursele/comenzile păstrează istoricul (audit #28).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/security/admin-audit";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import { logger } from "@/lib/logger";
import { sendFleetDecisionEmail } from "@/lib/email/templates/fleet";
import { assignTierOnApproval, getTierParams, TIER_COMMISSION_PCT } from "@/lib/drivers/tiers";
import { getOrCreateDriverCode } from "@/lib/drivers/referral";
import { missingDocuments, requiredDocumentsFor, type CourierKind } from "@/lib/fleet/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
    action: z.enum(["approve", "reject", "suspend", "reactivate", "delete"]),
    fleet_partner_id: z.string().uuid().nullable().optional(),
});

type CourierRow = { id: string; kind: CourierKind; full_name: string; email: string | null; verification_status: string };

const RETURNING = "RETURNING id, kind, full_name, email, verification_status";

const SQL: Record<z.infer<typeof BodySchema>["action"], string> = {
    approve: `UPDATE couriers
                 SET verification_status='approved', active=true,
                     fleet_partner_id=COALESCE($2, fleet_partner_id), updated_at=now()
               WHERE id=$1 AND deleted_at IS NULL ${RETURNING}`,
    reject: `UPDATE couriers
                SET verification_status='rejected', active=false, is_online=false, updated_at=now()
              WHERE id=$1 AND deleted_at IS NULL ${RETURNING}`,
    suspend: `UPDATE couriers SET active=false, is_online=false, updated_at=now()
               WHERE id=$1 AND deleted_at IS NULL ${RETURNING}`,
    reactivate: `UPDATE couriers SET active=true, updated_at=now()
                  WHERE id=$1 AND verification_status='approved' AND deleted_at IS NULL ${RETURNING}`,
    delete: `UPDATE couriers
                SET deleted_at=now(), active=false, is_online=false, updated_at=now()
              WHERE id=$1 AND deleted_at IS NULL ${RETURNING}`,
};

async function sendApplicantEmail(courier: CourierRow, action: "approve" | "reject", tier: string | null, referralCode: string | null) {
    if (!courier.email) return;
    let commission: { promoDays: number; pct: number; founding: boolean } | null = null;
    if (action === "approve") {
        const tierPct = tier ? TIER_COMMISSION_PCT[tier as keyof typeof TIER_COMMISSION_PCT] : null;
        if (tierPct !== null && tierPct !== undefined) {
            const { promoDays } = await getTierParams();
            commission = { promoDays, pct: tierPct, founding: tier === "founding15" };
        }
    }
    // Șablon tranzacțional localizat (lib/email/templates/fleet.ts) — escaparea e acolo.
    sendFleetDecisionEmail({
        to: courier.email,
        kind: courier.kind === "driver" ? "driver" : "courier",
        name: courier.full_name,
        decision: action,
        commission,
        referralCode,
    }).catch((err) => logger.warn({ err }, "[admin/fleet] applicant email failed"));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const actor = await requireAdmin(req, "mobility");
    if (actor instanceof NextResponse) return actor;
    try {
        const { id } = await params;
        if (!isUuidParam(id)) return invalidIdResponse();

        const parsed = BodySchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return NextResponse.json({ error: "invalid_action" }, { status: 400 });
        const { action } = parsed.data;
        const fleetPartnerId = parsed.data.fleet_partner_id ?? null;

        if (action === "approve") {
            const { rows: cur } = await dbQuery<{ kind: CourierKind }>(
                `SELECT kind FROM couriers WHERE id = $1 AND deleted_at IS NULL`,
                [id],
            );
            if (!cur[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });
            const missing = await missingDocuments(id, await requiredDocumentsFor(cur[0].kind));
            if (missing.length) {
                return NextResponse.json({ error: "documents_missing", missing }, { status: 409 });
            }
        }

        const { rows } = await dbQuery<CourierRow>(SQL[action], action === "approve" ? [id, fleetPartnerId] : [id]);
        if (!rows.length) return NextResponse.json({ error: "not_found" }, { status: 404 });
        const courier = rows[0];

        // La aprobare: treapta de comision (Founding Drivers) + codul de referral.
        // Best-effort — o eroare aici nu trebuie să blocheze aprobarea.
        let tier: string | null = null;
        let referralCode: string | null = null;
        if (action === "approve") {
            try {
                tier = (await assignTierOnApproval(id)).tier;
            } catch (err) {
                logger.error({ err, courierId: id }, "[admin/fleet] assignTierOnApproval failed");
            }
            try {
                referralCode = await getOrCreateDriverCode(id);
            } catch (err) {
                logger.error({ err, courierId: id }, "[admin/fleet] getOrCreateDriverCode failed");
            }
        }
        if (action === "approve" || action === "reject") {
            await sendApplicantEmail(courier, action, tier, referralCode).catch((err) =>
                logger.warn({ err }, "[admin/fleet] applicant email build failed"),
            );
        }

        await logAdminAction({
            action: `fleet_courier.${action}`,
            targetType: "courier",
            targetId: id,
            details: { fleet_partner_id: fleetPartnerId, tier },
            req,
            actor,
        });

        return NextResponse.json({ success: true, courier, tier, referral_code: referralCode });
    } catch (error) {
        logger.error({ err: error }, "[admin/fleet] PATCH error");
        return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
}
