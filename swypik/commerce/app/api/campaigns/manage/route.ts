/**
 * Swypik Cares — management campanii de către cauze VERIFICATE.
 *
 * POST  /api/campaigns/manage  → creează o campanie (status 'draft').
 * PATCH /api/campaigns/manage  → editează o campanie proprie.
 * GET   /api/campaigns/manage  → campaniile cauzelor userului logat.
 *
 * Doar cauzele cu verification_status='verified' pot crea/edita campanii.
 */
import { NextResponse } from "next/server";
import { frozenResponse, isEnabled } from "@/lib/feature-flags";
import { randomBytes } from "node:crypto";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { CampaignCreateSchema, CampaignUpdateSchema, parseBody } from "@/lib/validation/schemas";
import { withErrorHandling } from "@/lib/api-handler";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

/** Cauza aparține userului ȘI e verificată? */
async function assertVerifiedCause(causeId: string, userId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT id FROM donation_causes
      WHERE id = $1 AND owner_user_id = $2 AND verification_status = 'verified'`,
    [causeId, userId],
  );
  return rows.length > 0;
}

async function GET_impl(): Promise<Response> {
  if (!isEnabled("cares")) return frozenResponse("cares");
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const { rows } = await dbQuery(
    `SELECT c.id, c.cause_id, c.title, c.slug, c.story, c.goal_cents, c.raised_cents,
            c.currency, c.budget_breakdown, c.status, c.starts_at, c.ends_at,
            c.image_url, c.donors_count, cause.name AS cause_name
       FROM donation_campaigns c
       JOIN donation_causes cause ON cause.id = c.cause_id
      WHERE cause.owner_user_id = $1
      ORDER BY c.created_at DESC`,
    [session.userId],
  );
  return NextResponse.json({ success: true, campaigns: rows });
}

async function POST_impl(req: Request): Promise<Response> {
  if (!isEnabled("cares")) return frozenResponse("cares");
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const rl = await rateLimit("donations", `campaign:${session.userId}`, { limit: 10, window: 3600 });
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  const body: unknown = await req.json().catch(() => null);
  const parsed = parseBody(CampaignCreateSchema, body);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.error, code: parsed.code, issues: parsed.issues }, { status: 400 });
  }
  const d = parsed.data;

  if (!(await assertVerifiedCause(d.cause_id, session.userId))) {
    return NextResponse.json(
      { success: false, error: "Cauza nu îți aparține sau nu este verificată încă." },
      { status: 403 },
    );
  }

  const base = slugify(d.title) || "campanie";
  const { rows: existing } = await dbQuery<{ id: string }>(
    `SELECT id FROM donation_campaigns WHERE slug = $1`,
    [base],
  );
  const slug =
    existing.length > 0
      ? `${base}-${randomBytes(4).toString("hex").slice(0, 5)}`
      : base;

  const { rows } = await dbQuery<{ id: string; slug: string }>(
    `INSERT INTO donation_campaigns
       (cause_id, title, slug, story, goal_cents, currency,
        budget_breakdown, status, ends_at, image_url, video_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10)
     RETURNING id, slug`,
    [
      d.cause_id, d.title, slug, d.story ?? null, d.goal_cents, d.currency,
      JSON.stringify(d.budget_breakdown ?? []),
      d.ends_at ?? null, d.image_url ?? null, d.video_id ?? null,
    ],
  );

  logger.info({ userId: session.userId, campaignId: rows[0].id }, "[campaigns] created");
  return NextResponse.json({ success: true, campaign: rows[0] }, { status: 201 });
}

async function PATCH_impl(req: Request): Promise<Response> {
  if (!isEnabled("cares")) return frozenResponse("cares");
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const rl = await rateLimit("donations", `campaign_edit:${session.userId}`, { limit: 30, window: 3600 });
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  const body: unknown = await req.json().catch(() => null);
  const parsed = parseBody(CampaignUpdateSchema, body);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.error, code: parsed.code, issues: parsed.issues }, { status: 400 });
  }
  const { campaign_id, ...fields } = parsed.data;

  const { rows: owned } = await dbQuery<{ id: string; status: string }>(
    `SELECT c.id, c.status
       FROM donation_campaigns c
       JOIN donation_causes cause ON cause.id = c.cause_id
      WHERE c.id = $1 AND cause.owner_user_id = $2 AND cause.verification_status = 'verified'`,
    [campaign_id, session.userId],
  );
  if (owned.length === 0) {
    return NextResponse.json({ success: false, error: "Campania nu există sau nu îți aparține." }, { status: 404 });
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };

  if (fields.title !== undefined) push("title", fields.title);
  if (fields.story !== undefined) push("story", fields.story);
  if (fields.goal_cents !== undefined) push("goal_cents", fields.goal_cents);
  if (fields.budget_breakdown !== undefined) push("budget_breakdown", JSON.stringify(fields.budget_breakdown));
  if (fields.ends_at !== undefined) push("ends_at", fields.ends_at);
  if (fields.image_url !== undefined) push("image_url", fields.image_url);
  if (fields.video_id !== undefined) push("video_id", fields.video_id);
  if (fields.status !== undefined) push("status", fields.status);

  if (sets.length === 0) {
    return NextResponse.json({ success: false, error: "Nimic de actualizat." }, { status: 400 });
  }

  params.push(campaign_id);
  const { rows } = await dbQuery(
    `UPDATE donation_campaigns
        SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $${params.length}
      RETURNING id, title, slug, status, goal_cents, raised_cents, ends_at`,
    params,
  );

  logger.info({ userId: session.userId, campaign_id }, "[campaigns] updated");
  return NextResponse.json({ success: true, campaign: rows[0] });
}

export const GET = withErrorHandling(GET_impl);
export const POST = withErrorHandling(POST_impl);
export const PATCH = withErrorHandling(PATCH_impl);
