import { pollUntil } from "@/lib/media/poll";

/** Only a successful play response proves the webhook has granted access. */
export async function waitForMusicAccess(slug: string, signal?: AbortSignal): Promise<boolean> {
  const result = await pollUntil(
    () => fetch(`/api/music/tracks/${encodeURIComponent(slug)}/play`, { cache: "no-store", signal }).then((response) => response.ok),
    (unlocked) => unlocked,
    { signal },
  );
  return !signal?.aborted && result === true;
}
