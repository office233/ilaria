/**
 * Raportare cheltuieli (transparență Swypik Cares).
 *
 * POST /api/campaigns/manage/expenses → cauza verificată raportează o plată
 *   din banii strânși, cu dovadă (factură/chitanță, uploadată prin /api/upload).
 *   INSERT în donation_payouts cu status 'pending' (confirmare manuală de către admin).
 * GET /api/campaigns/manage/expenses?campaign_id= → cheltuielile proprii.
 */
import { NextResponse } from "next/server";
import { frozenResponse, isEnabled } from "@/lib/feature-flags";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { withErrorHandling } from "@/lib/api-handler";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ExpenseCreateSchema = z.object({
  campaign_id: z.string().uuid(),
  amount_cents: z.number().int().min(1).max(1_000_000_000),
  purpose: z.string().trim().min(3).max(500),
  proof_url: z.string().url().max(2048),
});

async function ownsCampaign(campaignId: string, userId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT c.id
       FROM donation_campaigns c
       JOIN donation_causes cause ON cause.id = c.cause_id
      WHERE c.id = $1 AND cause.owner_user_id = $2 AND cause.verification_status = 'verified'`,
    [campaignId, userId],
  );
  return rows.length > 0;
}

async function GET_impl(req: Request): Promise<Response> {
  if (!isEnabled("cares")) return frozenResponse("cares");
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const campaignId = url.searchParams.get("campaign_id")?.trim();
  if (!campaignId || !/^[0-9a-f-]{36}$/i.test(campaignId)) {
    return NextResponse.json({ success: false, error: "campaign_id invalid" }, { status: 400 });
  }
  if (!(await ownsCampaign(campaignId, session.userId))) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }
  const { rows } = await dbQuery(
    `SELECT id, amount_cents, currency, purpose, proof_url, status, created_at
       FROM donation_payouts
      WHERE campaign_id = $1
      ORDER BY created_at DESC`,
    [campaignId],
  );
  return NextResponse.json({ success: true, expenses: rows });
}

async function POST_impl(req: Request): Promise<Response> {
  if (!isEnabled("cares")) return frozenResponse("cares");
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const rl = await rateLimit("donations", `expense:${session.userId}`, { limit: 20, window: 3600 });
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  const body: unknown = await req.json().catch(() => null);
  const parsed = parseBody(ExpenseCreateSchema, body);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.error, code: parsed.code, issues: parsed.issues }, { status: 400 });
  }
  const d = parsed.data;

  if (!(await ownsCampaign(d.campaign_id, session.userId))) {
    return NextResponse.json(
      { success: false, error: "Campania nu există sau cauza nu e verificată." },
      { status: 403 },
    );
  }

  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO donation_payouts (campaign_id, amount_cents, purpose, proof_url, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id`,
    [d.campaign_id, d.amount_cents, d.purpose, d.proof_url],
  );

  logger.info({ userId: session.userId, payoutId: rows[0].id }, "[cares] expense reported");
  return NextResponse.json({ success: true, expense: { id: rows[0].id, status: "pending" } }, { status: 201 });
}

export const GET = withErrorHandling(GET_impl);
export const POST = withErrorHandling(POST_impl);
