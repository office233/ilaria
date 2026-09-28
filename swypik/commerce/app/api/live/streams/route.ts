import { withErrorHandling } from "@/lib/api-handler";
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { isLiveMediaConfigured } from "@/lib/live/config";
import { parseBody } from "@/lib/validation/schemas";
import { paginationSchema, queryObject } from "@/lib/validation/params";
import { z } from "zod";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const dynamic = "force-dynamic";

/** Statusuri publice listabile (whitelist; `failed` rămâne intern). */
const LIVE_LIST_STATUSES = ["live", "scheduled", "ended"] as const;
const LiveListQuerySchema = paginationSchema(20, 50).extend({
  status: z.enum(LIVE_LIST_STATUSES).default("live"),
});

const CreateStreamSchema = z.object({
  title: z.string().trim().min(1).max(140),
  description: z.string().trim().max(2000).optional().nullable(),
  scheduled_at: z.string().datetime({ offset: true }).optional().nullable(),
});

/**
 * POST /api/live/streams — creează un stream pe Cloudflare Realtime SFU, mereu
 * 'scheduled'. Devine 'live' DOAR după ce gazda publică și primul heartbeat
 * confirmă un track activ în SFU (lib/live/media.ts).
 */
async function POST_impl(req: NextRequest) {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "creator" && session.role !== "admin" && session.role !== "seller") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const rl = await rateLimit("liveStreams", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(CreateStreamSchema, await req.json().catch(() => ({})));
  if (!parsed.ok) return NextResponse.json({ error: "title_required", issues: parsed.issues }, { status: 400 });
  const { title, description, scheduled_at } = parsed.data;

  // Cheia rămâne (coloană NOT NULL UNIQUE), dar nu mai e un secret de ingest.
  const streamKey = crypto.randomBytes(16).toString("hex");
  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO live_streams (creator_id, title, description, stream_key, provider, scheduled_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [session.userId, title, description ?? null, streamKey, "cf_sfu", scheduled_at ?? null, "scheduled"],
  );

  return NextResponse.json({ id: rows[0].id, status: "scheduled", live_configured: isLiveMediaConfigured() });
}

async function GET_impl(req: NextRequest) {
  const url = new URL(req.url);
  const parsed = LiveListQuerySchema.safeParse(queryObject(url, ["status", "limit", "offset"]));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query", issues: parsed.error.issues }, { status: 400 });
  }
  const { status, limit, offset } = parsed.data;

  const { rows } = await dbQuery(
    `SELECT ls.id, ls.creator_id, ls.title, ls.description, ls.status, ls.viewer_count,
            ls.peak_viewers, ls.scheduled_at, ls.started_at, ls.ended_at,
            u.username, u.display_name, u.avatar_url
       FROM live_streams ls
       LEFT JOIN users u ON u.id::text = ls.creator_id
      WHERE ls.status = $1
      ORDER BY ls.started_at DESC NULLS LAST, ls.created_at DESC
      LIMIT $2 OFFSET $3`,
    [status, limit, offset],
  );

  return applyCachePolicy(NextResponse.json({ items: rows }), "live/streams", req);
}

export const POST = withErrorHandling(POST_impl);
export const GET = withErrorHandling(GET_impl);
