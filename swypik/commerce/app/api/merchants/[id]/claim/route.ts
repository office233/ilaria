/**
 * POST /api/merchants/[id]/claim — „Revendică afacerea”.
 * Proprietarul (utilizator logat) trimite o cerere; adminul o aprobă în
 * /admin/merchant-claims, care leagă sellerul și face profilul comandabil.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";
import { FOOD_RATE_LIMITS } from "@/lib/food/config";
import { createClaim } from "@/lib/food/claims";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ClaimSchema = z.object({
  contact_name: z.string().trim().min(2).max(120),
  contact_phone: z.string().trim().min(5).max(32).regex(/^[+\d][\d\s().-]{4,31}$/),
  contact_email: z.string().trim().email().max(254).optional().or(z.literal("")),
  message: z.string().trim().max(1000).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ success: false, error: "invalid_id", code: "invalid_id" }, { status: 400 });
    }
    const session = await getAuthSession();
    if (!session?.userId) {
      return NextResponse.json({ success: false, error: "unauthorized", code: "unauthorized" }, { status: 401 });
    }
    const rl = await rateLimit("foodClaim", session.userId, FOOD_RATE_LIMITS.claim);
    if (!rl.success) {
      return NextResponse.json({ success: false, error: "rate_limited", code: "rate_limited" }, { status: 429 });
    }

    const parsed = parseBody(ClaimSchema, await req.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error, code: parsed.code }, { status: 400 });
    }
    const d = parsed.data;

    const r = await createClaim({
      merchantId: id,
      userId: session.userId,
      contactName: d.contact_name,
      contactPhone: d.contact_phone,
      contactEmail: d.contact_email || null,
      message: d.message || null,
    });
    if (!r.ok) {
      const status = r.code === "not_found" ? 404 : 409;
      return NextResponse.json({ success: false, error: r.code, code: r.code }, { status });
    }
    return NextResponse.json({ success: true, claim_id: r.claimId }, { status: 201 });
  } catch (error: unknown) {
    logger.error({ err: error }, "[merchants/claim] POST error");
    return NextResponse.json({ success: false, error: "server_error", code: "server_error" }, { status: 500 });
  }
}
