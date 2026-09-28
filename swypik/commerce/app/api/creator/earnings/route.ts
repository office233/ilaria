/**
 * GET /api/creator/earnings — câștigurile creatorului din portofelul RON
 * (lib/creator/earnings.ts: sursa unică; comisioane, premii misiuni, Movies,
 * Music, creator fund, retrageri).
 */
import { NextResponse } from "next/server";
import { getCreatorUserIdWithRoleCheck } from "@/lib/creator/session";
import { getCreatorEarnings } from "@/lib/creator/earnings";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getCreatorUserIdWithRoleCheck();
  if (!session) return NextResponse.json({ error: "creator_required" }, { status: 403 });
  try {
    return NextResponse.json(await getCreatorEarnings(session.userId));
  } catch (err) {
    logger.error({ err }, "[creator/earnings] GET failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
