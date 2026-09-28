/**
 * GET /api/missions/active — lista pentru pickerul „Participă la o misiune”
 * din upload. Aceleași misiuni ca /api/missions (deschise, finanțate, RON),
 * plus `joined` = misiunile la care userul curent are deja un clip activ.
 *
 * Răspuns: { missions: PublicMission[], joinedMissionIds: string[] }
 * Clipul se leagă de misiune prin PATCH /api/creator/videos/[id] { missionId }.
 */
import { NextResponse } from "next/server";
import { listOpenMissions, missionIdsJoinedBy } from "@/lib/missions/repo";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const PICKER_LIMIT = 50;

export async function GET() {
  try {
    const auth = await getAuthUser();
    const [missions, joined] = await Promise.all([
      listOpenMissions(PICKER_LIMIT),
      auth.userId ? missionIdsJoinedBy(auth.userId) : Promise.resolve([] as string[]),
    ]);
    return NextResponse.json(
      { missions, joinedMissionIds: joined },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (err) {
    logger.error({ err }, "[api/missions/active] GET failed");
    return NextResponse.json({ error: "internal_error", missions: [], joinedMissionIds: [] }, { status: 500 });
  }
}
