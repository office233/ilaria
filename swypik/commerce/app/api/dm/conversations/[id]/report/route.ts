import { NextResponse } from "next/server";
import { z } from "zod";
import { getAccountUserId } from "@/lib/social/session";
import { reportConversation } from "@/lib/dm/report";
import { DM_CONFIG, DM_REPORT_REASONS } from "@/lib/dm/config";
import { dmDisabledResponse, dmErrorResponse, dmRateLimit, unauthorized } from "@/lib/dm/http";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { parseBody } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

const ReportSchema = z.object({
  reason: z.enum(DM_REPORT_REASONS),
  message_id: z.string().uuid().optional().nullable(),
  note: z.string().trim().max(1000).optional().nullable(),
});

/** POST /api/dm/conversations/[id]/report { reason, message_id?, note? } */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  try {
    const userId = await getAccountUserId();
    if (!userId) return unauthorized();
    const { id } = await params;
    if (!isUuidParam(id)) return invalidIdResponse();
    const limited = await dmRateLimit(request, "dmReport", userId, DM_CONFIG.rate.report);
    if (limited) return limited;
    const parsed = parseBody(ReportSchema, await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error, issues: parsed.issues }, { status: 400 });

    const reportId = await reportConversation(userId, id, {
      reason: parsed.data.reason,
      messageId: parsed.data.message_id ?? null,
      note: parsed.data.note ?? null,
    });
    return NextResponse.json({ ok: true, report_id: reportId });
  } catch (err: unknown) {
    return dmErrorResponse(err, "report");
  }
}
