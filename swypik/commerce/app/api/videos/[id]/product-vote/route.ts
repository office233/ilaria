import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { parseBody, VideoProductVoteSchema } from "@/lib/validation/schemas";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as Record<string, string>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_RE = /^[A-Za-z0-9._:-]{8,80}$/;

function normalizeSessionId(value: string | undefined): string | null {
  const trimmed = String(value || "").trim();
  return SESSION_RE.test(trimmed) ? trimmed : null;
}

async function loadVoteCounts(videoId: string, productId: string) {
  const { rows } = await dbQuery<{
    worth_it_count: number | string;
    not_worth_it_count: number | string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE vote = 'worth_it')::int AS worth_it_count,
       COUNT(*) FILTER (WHERE vote = 'not_worth_it')::int AS not_worth_it_count
     FROM video_product_votes
     WHERE video_id = $1 AND product_id = $2`,
    [videoId, productId],
  );

  const worthIt = Number(rows[0]?.worth_it_count || 0);
  const notWorthIt = Number(rows[0]?.not_worth_it_count || 0);
  return { worthIt, notWorthIt, total: worthIt + notWorthIt };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: videoId } = await params;
    if (!UUID_RE.test(videoId)) {
      return NextResponse.json({ error: "Invalid video id" }, { status: 400, headers: NO_STORE });
    }

    const rawBody = await req.json().catch(() => null);
    const parsed = parseBody(VideoProductVoteSchema, rawBody);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error, issues: parsed.issues }, { status: 400, headers: NO_STORE });
    }

    const productId = parsed.data.productId;
    const vote = parsed.data.vote;
    const sessionId = normalizeSessionId(parsed.data.sessionId);
    const userId = await getOptionalSocialUserId();

    if (!userId && !sessionId) {
      return NextResponse.json({ error: "sessionId required" }, { status: 400, headers: NO_STORE });
    }

    const rl = await rateLimit("videoVote", userId || sessionId || getClientIP(req));
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });

    const linked = await dbQuery<{ id: string }>(
      `SELECT mp.id
       FROM videos v
       JOIN marketplace_products mp ON mp.id = $2::uuid
       WHERE v.id = $1::uuid
         AND v.status = 'ready'
         AND v.is_hidden = false
         AND v.visibility = 'public'
         AND v.effective_label = 'safe'
         AND mp.status = 'active'
         AND COALESCE(mp.is_adult, false) = false
         AND (
           EXISTS (
             SELECT 1 FROM video_product_links vpl
             WHERE vpl.video_id = v.id AND vpl.product_id = mp.id
           )
           OR EXISTS (
             SELECT 1
             FROM jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(COALESCE(v.product_refs, '[]'::jsonb)) = 'array' THEN COALESCE(v.product_refs, '[]'::jsonb)
                 ELSE '[]'::jsonb
               END
             ) AS ref(value)
             WHERE COALESCE(ref.value->>'product_id', TRIM(BOTH '"' FROM ref.value::text)) = mp.id::text
           )
         )
       LIMIT 1`,
      [videoId, productId],
    );

    if (linked.rows.length === 0) {
      return NextResponse.json({ error: "Product is not linked to this video" }, { status: 404, headers: NO_STORE });
    }

    const metadata = JSON.stringify({ source: "explore_product_drawer" });

    if (userId) {
      await dbQuery(
        `INSERT INTO video_product_votes (video_id, product_id, user_id, session_id, vote, metadata)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb)
         ON CONFLICT (video_id, product_id, user_id) WHERE user_id IS NOT NULL
         DO UPDATE SET
           vote = EXCLUDED.vote,
           session_id = COALESCE(EXCLUDED.session_id, video_product_votes.session_id),
           metadata = video_product_votes.metadata || EXCLUDED.metadata,
           updated_at = now()`,
        [videoId, productId, userId, sessionId, vote, metadata],
      );
    } else {
      await dbQuery(
        `INSERT INTO video_product_votes (video_id, product_id, session_id, vote, metadata)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)
         ON CONFLICT (video_id, product_id, session_id) WHERE user_id IS NULL AND session_id IS NOT NULL
         DO UPDATE SET
           vote = EXCLUDED.vote,
           metadata = video_product_votes.metadata || EXCLUDED.metadata,
           updated_at = now()`,
        [videoId, productId, sessionId, vote, metadata],
      );
    }

    const counts = await loadVoteCounts(videoId, productId);

    return NextResponse.json(
      {
        ok: true,
        videoId,
        productId,
        vote,
        votes: { ...counts, viewerVote: vote },
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    logger.error({ err: error }, "Video product vote failed");
    return NextResponse.json({ error: "vote_failed" }, { status: 500, headers: NO_STORE });
  }
}
