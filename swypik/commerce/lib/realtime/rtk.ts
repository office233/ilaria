/**
 * Client REST pentru Cloudflare RealtimeKit (apeluri Messenger).
 * Docs: https://developers.cloudflare.com/api/resources/realtime_kit/
 *   POST /accounts/{acct}/realtime/kit/{app}/meetings                       → { data: { id } }
 *   POST /accounts/{acct}/realtime/kit/{app}/meetings/{id}/participants     → { data: { id, token } }
 *   PATCH /accounts/{acct}/realtime/kit/{app}/meetings/{id} { status }      → închide meeting-ul
 * Token-ul participantului (JWT) e singurul lucru care ajunge în browser.
 */
import { requireRtkConfig } from "./config";
import { RealtimeApiError, realtimeFetch } from "./http";

type Envelope<T> = { success?: boolean; data?: T };

export type CallMedia = "audio" | "video";

function kitUrl(path: string): { url: string; token: string } {
  const cfg = requireRtkConfig();
  const base = `${cfg.apiBaseUrl}/accounts/${encodeURIComponent(cfg.accountId)}/realtime/kit/${encodeURIComponent(cfg.appId)}`;
  return { url: `${base}${path}`, token: cfg.apiToken };
}

export async function createMeeting(title: string): Promise<string> {
  const { url, token } = kitUrl("/meetings");
  const res = await realtimeFetch<Envelope<{ id?: string }>>(url, token, "POST", { title });
  const id = res.data?.id;
  if (!id) throw new RealtimeApiError(502, "no_meeting", "RealtimeKit did not return a meeting id");
  return id;
}

/** Presetarea RealtimeKit pentru tipul de apel (audio-only e de ~4× mai ieftin). */
export function presetFor(media: CallMedia): string {
  const cfg = requireRtkConfig();
  return media === "audio" ? cfg.presetAudio : cfg.presetVideo;
}

export async function addParticipant(
  meetingId: string,
  input: { userId: string; name: string; media: CallMedia; picture?: string | null },
): Promise<{ participantId: string; authToken: string }> {
  const { url, token } = kitUrl(`/meetings/${encodeURIComponent(meetingId)}/participants`);
  const res = await realtimeFetch<Envelope<{ id?: string; token?: string }>>(url, token, "POST", {
    name: input.name,
    preset_name: presetFor(input.media),
    // Id intern stabil (UUID), niciodată date personale (docs RealtimeKit).
    custom_participant_id: input.userId,
    ...(input.picture ? { picture: input.picture } : {}),
  });
  if (!res.data?.token || !res.data.id) throw new RealtimeApiError(502, "no_token", "RealtimeKit did not return a participant token");
  return { participantId: res.data.id, authToken: res.data.token };
}

/** Marchează meeting-ul inactiv (nimeni nu mai poate intra). Best-effort la apelant. */
export async function deactivateMeeting(meetingId: string): Promise<void> {
  const { url, token } = kitUrl(`/meetings/${encodeURIComponent(meetingId)}`);
  await realtimeFetch<unknown>(url, token, "PATCH", { status: "INACTIVE" });
}
