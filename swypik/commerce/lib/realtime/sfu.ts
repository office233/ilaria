/**
 * Client pentru Cloudflare Realtime SFU (Connection API,
 * https://developers.cloudflare.com/realtime/sfu/api/). Doar pe server: App
 * Secret-ul nu ajunge niciodată în browser — clientul trimite SDP-ul la API-ul
 * nostru, care verifică autorizarea și face apelul aici.
 */
import { requireSfuConfig } from "./config";
import { RealtimeApiError, realtimeFetch } from "./http";

export type SessionDescription = { type: "offer" | "answer"; sdp: string };

export type LocalTrack = { location: "local"; mid: string; trackName: string };
export type RemoteTrack = {
  location: "remote";
  sessionId: string;
  trackName: string;
  simulcast?: { preferredRid: string; priorityOrdering?: string; ridNotAvailable?: string };
};

export type TrackResult = {
  trackName?: string;
  mid?: string;
  sessionId?: string;
  errorCode?: string;
  errorDescription?: string;
};

export type TracksResponse = {
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: SessionDescription;
  tracks?: TrackResult[];
};

export type SessionInfo = {
  tracks?: Array<{ location?: string; mid?: string; trackName?: string; status?: string }>;
};

function appUrl(path: string): { url: string; token: string } {
  const cfg = requireSfuConfig();
  return { url: `${cfg.baseUrl}/apps/${encodeURIComponent(cfg.appId)}${path}`, token: cfg.appToken };
}

function sessionPath(sessionId: string, suffix = ""): string {
  return `/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

export async function createSfuSession(): Promise<string> {
  const { url, token } = appUrl("/sessions/new");
  const res = await realtimeFetch<{ sessionId?: string }>(url, token, "POST");
  if (!res.sessionId) throw new RealtimeApiError(502, "no_session", "SFU did not return a sessionId");
  return res.sessionId;
}

/** Aruncă dacă vreun track din răspuns a eșuat (rezultatele sunt per track). */
function assertTracksOk(res: TracksResponse): TracksResponse {
  const failed = res.tracks?.find((t) => t.errorCode);
  if (failed) throw new RealtimeApiError(502, failed.errorCode ?? "track_failed", failed.errorDescription ?? "track failed");
  return res;
}

/** Gazda publică: oferta browserului + track-urile locale → răspunsul SFU. */
export async function publishTracks(sessionId: string, offer: SessionDescription, tracks: LocalTrack[]): Promise<TracksResponse> {
  const { url, token } = appUrl(sessionPath(sessionId, "/tracks/new"));
  const res = await realtimeFetch<TracksResponse>(url, token, "POST", { sessionDescription: offer, tracks });
  return assertTracksOk(res);
}

/** Spectatorul trage track-urile gazdei → oferta SFU (la care browserul răspunde). */
export async function pullTracks(sessionId: string, tracks: RemoteTrack[]): Promise<TracksResponse> {
  const { url, token } = appUrl(sessionPath(sessionId, "/tracks/new"));
  const res = await realtimeFetch<TracksResponse>(url, token, "POST", { tracks });
  return assertTracksOk(res);
}

export async function renegotiate(sessionId: string, answer: SessionDescription): Promise<void> {
  const { url, token } = appUrl(sessionPath(sessionId, "/renegotiate"));
  await realtimeFetch<unknown>(url, token, "PUT", { sessionDescription: answer });
}

export async function getSfuSession(sessionId: string): Promise<SessionInfo> {
  const { url, token } = appUrl(sessionPath(sessionId));
  return realtimeFetch<SessionInfo>(url, token, "GET");
}

/** true dacă sesiunea are cel puțin un track local activ (gazda chiar publică). */
export function hasActiveLocalTrack(info: SessionInfo): boolean {
  return (info.tracks ?? []).some((t) => t.location === "local" && t.status === "active");
}
