/**
 * Hub-ul realtime al procesului (o singură conexiune Redis de abonare per
 * replică). Vezi `./hub.ts` pentru motivație.
 */
import { createSubscriber, getRedis } from "@/lib/redis";
import { createRealtimeHub, type RealtimeHub } from "./hub";

let hub: RealtimeHub | null = null;

export function getRealtimeHub(): RealtimeHub {
  if (!hub) hub = createRealtimeHub({ createSubscriber, getPublisher: getRedis });
  return hub;
}

/** PUBLISH cross-replică; nu aruncă (întoarce `false` dacă Redis lipsește). */
export async function publishRealtime(channel: string, payload: unknown): Promise<boolean> {
  try {
    return await getRealtimeHub().publish(channel, payload);
  } catch {
    return false;
  }
}

/** Numele canalelor — o singură sursă de adevăr pentru publisheri și abonați. */
export const realtimeChannels = {
  dispatchJob: (jobId: string) => `dispatch:job:${jobId}`,
  liveChat: (streamId: string) => `live:chat:${streamId}`,
  cacheInvalidate: "cache:invalidate",
  videoWakeup: process.env.VIDEO_WAKEUP_CHANNEL || "video:jobs:wakeup",
} as const;
