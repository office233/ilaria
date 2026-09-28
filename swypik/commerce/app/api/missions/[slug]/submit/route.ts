/**
 * POST /api/missions/[slug]/submit { videoId } — creatorul înscrie un clip.
 * GET — înscrierile userului curent la această misiune.
 * Validarea e comună cu PATCH /api/creator/videos/[id] { missionId }
 * (lib/missions/submissions.ts). Erorile sunt coduri stabile (UI le traduce).
 */
import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getCreatorUserIdWithRoleCheck } from "@/lib/creator/session";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { missionSubmitSchema } from "@/lib/missions/schemas";
import { linkErrorStatus, linkVideoToMission } from "@/lib/missions/submissions";

export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9-]{1,120}$/;

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: "mission_not_open" }, { status: 404 });

  const session = await getCreatorUserIdWithRoleCheck();
  if (!session) return NextResponse.json({ error: "creator_required" }, { status: 403 });

  const rl = await rateLimit("mission-submit", session.userId, { limit: 10, window: 60 });
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(missionSubmitSchema, await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: "invalid_body", code: parsed.code }, { status: 400 });

  const { rows } = await dbQuery<{ id: string }>(`SELECT id FROM creator_missions WHERE slug = $1`, [slug]);
  if (!rows[0]) return NextResponse.json({ error: "mission_not_open" }, { status: 404 });

  const result = await linkVideoToMission({ userId: session.userId, videoId: parsed.data.videoId, missionId: rows[0].id });
  if (!result.ok) return NextResponse.json({ error: result.code }, { status: linkErrorStatus(result.code) });
  return NextResponse.json(
    { ok: true, submissionId: result.submissionId, alreadyLinked: result.alreadyLinked },
    { status: result.alreadyLinked ? 200 : 201 },
  );
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const userId = await getOptionalSocialUserId();
  if (!userId || !SLUG_RE.test(slug)) return NextResponse.json({ submissions: [] });

  const { rows } = await dbQuery(
    `SELECT s.id, s.video_id, s.status, s.payout_minor, s.payout_currency, s.paid_at, s.submitted_at
       FROM creator_mission_submissions s
       JOIN creator_missions m ON m.id = s.mission_id
      WHERE m.slug = $1 AND s.user_id = $2
      ORDER BY s.submitted_at DESC`,
    [slug, userId],
  );
  return NextResponse.json({ submissions: rows });
}
