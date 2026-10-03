import { redirect } from "next/navigation";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import { isLiveMediaConfigured } from "@/lib/live/config";
import LiveStudioClient, { type StudioStream } from "./LiveStudioClient";

export const dynamic = "force-dynamic";

const STUDIO_LIST_LIMIT = 50;

export default async function CreatorLivePage() {
  const session = await getAuthSession();
  if (!session) redirect("/auth?next=/creator/live");
  if (session.role !== "creator" && session.role !== "admin" && session.role !== "seller") {
    redirect("/become-a-creator");
  }
  const { rows } = await dbQuery<StudioStream>(
    `SELECT id, title, status, viewer_count, peak_viewers, scheduled_at, started_at, created_at
       FROM live_streams WHERE creator_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [session.userId, STUDIO_LIST_LIMIT],
  );
  return <LiveStudioClient streams={rows} configured={isLiveMediaConfigured()} />;
}
