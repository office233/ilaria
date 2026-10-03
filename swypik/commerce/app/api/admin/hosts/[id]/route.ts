/**
 * POST /api/admin/hosts/[id] — acțiuni pe aplicațiile de gazdă.
 * Body: { action: "approve" | "reject" | "needs_info", note?: string }
 *
 * approve → status approved (publicarea listing-ului e pas separat, după
 *           ce gazda își completează calendarul și pozele).
 * reject / needs_info → cer motiv (audit).
 */
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { hasAdminSession, isAdminToken } from "@/lib/security/admin-auth";
import { logger } from "@/lib/logger";
import { logAdminAction } from "@/lib/security/admin-audit";
import { ensureHostFromApplication } from "@/lib/stays/hosts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isAdmin(req: Request): Promise<boolean> {
    const bearer = req.headers.get("authorization");
    if (bearer?.startsWith("Bearer ") && isAdminToken(bearer.slice(7))) return true;
    return hasAdminSession();
}

const schema = z.object({
    action: z.enum(["approve", "reject", "needs_info"]),
    note: z.string().max(1000).optional(),
});

export const POST = withErrorHandling(async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!(await isAdmin(req))) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "invalid_data" }, { status: 400 });
    }
    const { action, note } = parsed.data;

    if ((action === "reject" || action === "needs_info") && !note?.trim()) {
        return NextResponse.json({ error: "reason_required" }, { status: 400 });
    }

    const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "needs_info";
    const { rows } = await dbQuery<{ id: string; email: string; property_name: string; user_id: string | null }>(
        `UPDATE host_applications
            SET status = $1, admin_notes = COALESCE($2, admin_notes),
                reviewed_by = 'admin', reviewed_at = NOW(), updated_at = NOW()
          WHERE id = $3 AND status IN ('pending','needs_info')
          RETURNING id, email, property_name, user_id::text`,
        [status, note?.trim() || null, id],
    );
    if (!rows.length) {
        return NextResponse.json({ error: "application_not_found_or_processed" }, { status: 404 });
    }

    // Model unic de gazdă (20260926_0051): aprobarea creează gazda activă.
    if (action === "approve" && rows[0].user_id) {
        await ensureHostFromApplication(rows[0].user_id, rows[0].id);
    }

    logger.info({ applicationId: id, action }, "host application reviewed");
    await logAdminAction({
      action: `host.${action}`,
      targetType: "host_application",
      targetId: id,
      details: { note },
      req,
    });
    return NextResponse.json({ ok: true, status });
});
