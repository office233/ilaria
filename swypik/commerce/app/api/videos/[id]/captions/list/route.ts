import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { applyCachePolicy } from "@/lib/http/cache-policy";
import { CAPTIONS_ENABLED_SQL } from "@/lib/feed/visibility";

export const dynamic = "force-dynamic";

async function GET_impl(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const { rows } = await dbQuery<{ lang: string }>(
    // Aceleași reguli ca subtitrarea publică: fără oracol de existență pentru
    // clipuri draft/private/ascunse sau cu subtitrările oprite de creator.
    `SELECT c.lang
       FROM video_captions c
       JOIN videos v ON v.id = c.video_id
      WHERE c.video_id = $1
        AND v.status = 'ready' AND v.visibility IN ('public', 'unlisted')
        AND v.is_hidden = false AND v.effective_label = 'safe'
        AND ${CAPTIONS_ENABLED_SQL}
      ORDER BY c.lang`,
    [id],
  );
  return applyCachePolicy(
    NextResponse.json({ languages: rows.map((r) => r.lang) }),
    "videos/[id]/captions/list",
    req,
  );
}

export const GET = withErrorHandling(GET_impl);
