import { withErrorHandling } from "@/lib/api-handler";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { endLiveStream } from "@/lib/live/media";
import { getLiveItems, getLiveStream } from "@/lib/live/queries";
import { rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { parseBody } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET — streamul public (fără cheie/URL-uri de ingest) + produsele prezentate. */
async function GET_impl(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const stream = await getLiveStream(id);
  if (!stream) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const items = await getLiveItems(id);
  return NextResponse.json({ stream, items });
}

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  description: z.string().trim().max(2000).optional(),
  status: z.literal("ended").optional(),
});

/** PATCH { title?, description?, status?: "ended" } — doar creatorul (sau admin). */
async function PATCH_impl(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("liveStreamEdit", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const { rows: ownRows } = await dbQuery<{ creator_id: string }>(`SELECT creator_id FROM live_streams WHERE id = $1`, [id]);
  if (!ownRows[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (ownRows[0].creator_id !== session.userId && session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = parseBody(PatchSchema, await req.json().catch(() => ({})));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { title, description, status } = parsed.data;

  if (title !== undefined || description !== undefined) {
    await dbQuery(
      `UPDATE live_streams SET title = COALESCE($2, title), description = COALESCE($3, description) WHERE id = $1`,
      [id, title ?? null, description ?? null],
    );
  }
  if (status === "ended") {
    // ended + curăță heartbeat-urile din Redis + anunță spectatorii (SSE). Track-urile
    // SFU ale gazdei expiră singure când browserul gazdei închide conexiunea.
    await endLiveStream(id, { includeScheduled: true });
  }
  return NextResponse.json({ ok: true });
}

export const GET = withErrorHandling(GET_impl);
export const PATCH = withErrorHandling(PATCH_impl);
