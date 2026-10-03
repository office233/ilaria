/**
 * Swypik Cares — campanii de donații.
 *
 * GET /api/campaigns              → listă publică (active, cu progres)
 * GET /api/campaigns?slug=...     → o campanie cu payouts (transparență)
 */
import { NextResponse } from "next/server";
import { frozenResponse, isEnabled } from "@/lib/feature-flags";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isEnabled("cares")) return frozenResponse("cares");
  try {
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug")?.trim();
    const kind = url.searchParams.get("kind")?.trim() || null;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);

    if (slug) {
      const { rows } = await dbQuery(
        `SELECT c.id, c.title, c.slug, c.story, c.goal_cents, c.raised_cents,
                c.currency, c.budget_breakdown, c.status, c.starts_at, c.ends_at,
                c.image_url, c.video_id, c.donors_count,
                dc.name AS cause_name, dc.kind AS cause_kind,
                dc.location_city, dc.verification_status
           FROM donation_campaigns c
           JOIN donation_causes dc ON dc.id = c.cause_id
          WHERE c.slug = $1 AND c.status IN ('active', 'funded', 'closed')`,
        [slug],
      );
      const campaign = rows[0];
      if (!campaign) {
        return NextResponse.json({ success: false, error: "Campania nu există." }, { status: 404 });
      }

      // Transparență: plățile efectuate + ultimele donații (fără date personale).
      const [{ rows: payouts }, { rows: recent }] = await Promise.all([
        dbQuery(
          `SELECT amount_cents, currency, purpose, proof_url, status, sent_at
             FROM donation_payouts WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [campaign.id],
        ),
        dbQuery(
          `SELECT CASE WHEN is_anonymous THEN 'Anonim' ELSE COALESCE(donor_name, 'Anonim') END AS donor,
                  amount_cents, currency, message, created_at
             FROM donations
            WHERE campaign_id = $1 AND payment_status = 'paid'
            ORDER BY created_at DESC LIMIT 20`,
          [campaign.id],
        ),
      ]);

      return NextResponse.json({ success: true, campaign, payouts, recent_donations: recent });
    }

    const params: unknown[] = [];
    const where: string[] = [
      "c.status = 'active'",
      "dc.verification_status = 'verified'",
      "(c.ends_at IS NULL OR c.ends_at > now())",
    ];
    if (kind && ["ngo", "family", "small_business", "community", "emergency"].includes(kind)) {
      params.push(kind);
      where.push(`dc.kind = $${params.length}`);
    }
    params.push(limit);

    const { rows } = await dbQuery(
      `SELECT c.id, c.title, c.slug, c.goal_cents, c.raised_cents, c.currency,
              c.image_url, c.video_id, c.donors_count, c.ends_at,
              dc.name AS cause_name, dc.kind AS cause_kind, dc.location_city
         FROM donation_campaigns c
         JOIN donation_causes dc ON dc.id = c.cause_id
        WHERE ${where.join(" AND ")}
        ORDER BY c.created_at DESC
        LIMIT $${params.length}`,
      params,
    );

    return NextResponse.json({ success: true, campaigns: rows });
  } catch (error: unknown) {
    logger.error({ err: error }, "[campaigns] GET error");
    return NextResponse.json({ success: false, error: "Eroare la încărcarea campaniilor." }, { status: 500 });
  }
}
