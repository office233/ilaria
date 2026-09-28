import { notFound, redirect } from "next/navigation";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";
import HostStudio from "@/components/live/studio/HostStudio";
import { getAuthSession } from "@/lib/auth/session";
import { isLiveMediaConfigured, LIVE_CONFIG } from "@/lib/live/config";
import { getLiveItems, getLiveStream } from "@/lib/live/queries";
import { isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";

/** Studio-ul unui stream: doar creatorul lui (sau admin). */
export default async function CreatorLiveHostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidParam(id)) notFound();
  const session = await getAuthSession();
  if (!session) redirect(`/auth?next=/creator/live/${id}`);
  const stream = await getLiveStream(id);
  if (!stream || (stream.creator_id !== session.userId && session.role !== "admin")) notFound();
  const items = await getLiveItems(id);

  return (
    <ImmersiveSurface>
      <HostStudio initialStream={stream} initialItems={items} configured={isLiveMediaConfigured()} pollMs={LIVE_CONFIG.viewerPollMs} />
    </ImmersiveSurface>
  );
}
