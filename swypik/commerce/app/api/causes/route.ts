/**
 * Swypik Cares — înregistrare beneficiar/ONG (cauză).
 *
 * POST /api/causes → INSERT în donation_causes cu verification_status='pending'.
 *   Aprobarea nu are încă UI (Multi-ERP retras 2026-09-28; FEATURE_CARES e OFF).
 * GET  /api/causes → cauzele userului logat (pentru panoul de cauze).
 */
import { NextResponse } from "next/server";
import { frozenResponse, isEnabled } from "@/lib/feature-flags";
import { randomBytes } from "node:crypto";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { CauseRegisterSchema, parseBody } from "@/lib/validation/schemas";
import { withErrorHandling } from "@/lib/api-handler";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

async function GET_impl(): Promise<Response> {
  if (!isEnabled("cares")) return frozenResponse("cares");
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const { rows } = await dbQuery(
    `SELECT id, kind, name, slug, description, verification_status,
            contact_name, contact_email, location_city, image_url, created_at
       FROM donation_causes
      WHERE owner_user_id = $1
      ORDER BY created_at DESC`,
    [session.userId],
  );
  return NextResponse.json({ success: true, causes: rows });
}

async function POST_impl(req: Request): Promise<Response> {
  if (!isEnabled("cares")) return frozenResponse("cares");
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const rl = await rateLimit("donations", `cause:${session.userId}`, { limit: 5, window: 3600 });
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  const body: unknown = await req.json().catch(() => null);
  const parsed = parseBody(CauseRegisterSchema, body);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.error, code: parsed.code, issues: parsed.issues }, { status: 400 });
  }
  const d = parsed.data;

  // slug unic — sufix scurt dacă e deja luat
  const base = slugify(d.name) || "cauza";
  const suffix = randomBytes(4).toString("hex").slice(0, 5);
  const { rows: existing } = await dbQuery<{ id: string }>(
    `SELECT id FROM donation_causes WHERE slug = $1`,
    [base],
  );
  const slug = existing.length > 0 ? `${base}-${suffix}` : base;

  const { rows } = await dbQuery<{ id: string; slug: string }>(
    `INSERT INTO donation_causes
       (kind, name, slug, description, legal_id, documents,
        verification_status, contact_name, contact_email, contact_phone,
        location_country, location_city, image_url, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, slug`,
    [
      d.kind, d.name, slug, d.description ?? null, d.legal_id ?? null,
      JSON.stringify(d.documents ?? {}),
      d.contact_name, d.contact_email, d.contact_phone ?? null,
      d.location_country, d.location_city ?? null, d.image_url ?? null,
      session.userId,
    ],
  );

  logger.info({ userId: session.userId, causeId: rows[0].id }, "[causes] cause registered (pending)");
  return NextResponse.json(
    { success: true, cause: { id: rows[0].id, slug: rows[0].slug, verification_status: "pending" } },
    { status: 201 },
  );
}

export const GET = withErrorHandling(GET_impl);
export const POST = withErrorHandling(POST_impl);
