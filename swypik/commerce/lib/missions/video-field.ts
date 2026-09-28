/**
 * Câmpul `missionId` din API-ul de metadate video
 * (PATCH /api/creator/videos/[id]):
 *   - uuid → înscrie clipul la misiune (validări în linkVideoToMission);
 *   - null → retrage clipul (doar dacă nu a fost încă jurizat).
 * Codurile de eroare sunt stabile; pickerul din upload le traduce.
 */
import { videoMissionFieldSchema } from "./schemas";
import { linkErrorStatus, linkVideoToMission, unlinkVideoFromMission } from "./submissions";

export type MissionFieldOutcome =
  | { ok: true; value: { missionId: string | null; submissionId: string | null } }
  | { ok: false; code: string; status: number };

export async function applyVideoMissionField(args: {
  userId: string;
  videoId: string;
  missionId: unknown;
}): Promise<MissionFieldOutcome> {
  const parsed = videoMissionFieldSchema.safeParse(args.missionId);
  if (!parsed.success) return { ok: false, code: "invalid_mission_id", status: 400 };

  if (parsed.data === null) {
    await unlinkVideoFromMission({ userId: args.userId, videoId: args.videoId });
    return { ok: true, value: { missionId: null, submissionId: null } };
  }

  const res = await linkVideoToMission({ userId: args.userId, videoId: args.videoId, missionId: parsed.data });
  if (!res.ok) return { ok: false, code: res.code, status: linkErrorStatus(res.code) };
  return { ok: true, value: { missionId: parsed.data, submissionId: res.submissionId } };
}
