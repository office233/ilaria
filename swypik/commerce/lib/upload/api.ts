/**
 * Clientul HTTP al fluxului de creare video (browser). Toate erorile devin
 * UploadApiError cu `code` stabil (tradus în UI prin videoUpload.errors.*).
 */
import type { UploadStatus } from "@/lib/video/upload/status";
import type { VideoDetailsInput } from "@/lib/video/upload/schemas";
import type { CaptionTrack } from "@/lib/video/captions";

export type { UploadStatus };

export class UploadApiError extends Error {
  code: string;
  status: number;
  missing?: number[];
  /** PATCH cu detalii salvate, dar înscrierea la misiune a eșuat. */
  saved?: VideoPatchResult;
  constructor(code: string, status: number, missing?: number[], saved?: VideoPatchResult) {
    super(code);
    this.name = "UploadApiError";
    this.code = code;
    this.status = status;
    this.missing = missing;
    this.saved = saved;
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new UploadApiError("network_error", 0);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof body.code === "string" ? body.code : typeof body.error === "string" ? body.error : "error";
    const saved = body.detailsSaved === true ? (body.video as VideoPatchResult) : undefined;
    throw new UploadApiError(code, res.status, Array.isArray(body.missing) ? (body.missing as number[]) : undefined, saved);
  }
  return body as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const SESSION = "/api/creator/upload-session";

export type CreatedSession = { sessionId: string; videoId: string; partSize: number; totalParts: number; expiresAt: string };

export const uploadApi = {
  createSession: (body: { filename: string; contentType: string; sizeBytes: number; source: "gallery" | "camera" }) =>
    call<CreatedSession>(SESSION, json("POST", body)),
  openSessions: () => call<{ sessions: UploadStatus[] }>(SESSION).then((r) => r.sessions),
  signParts: (sessionId: string, partNumbers: number[]) =>
    call<{ parts: Array<{ partNumber: number; url: string }> }>(`${SESSION}/${sessionId}/parts`, json("POST", { partNumbers })).then(
      (r) => r.parts,
    ),
  listParts: (sessionId: string) =>
    call<{ partSize: number; totalParts: number; uploaded: Array<{ partNumber: number; size: number }> }>(
      `${SESSION}/${sessionId}/parts`,
    ),
  complete: (sessionId: string, trim: { startMs: number | null; endMs: number | null }) =>
    call<{ videoId: string; jobId: string | null; status: string }>(`${SESSION}/${sessionId}/complete`, json("POST", { trim })),
  abort: (sessionId: string) => call<{ aborted: boolean }>(`${SESSION}/${sessionId}`, { method: "DELETE" }),
  status: (sessionId: string) => call<UploadStatus>(`${SESSION}/${sessionId}`),
};

export type VideoPatchResult = {
  videoId: string;
  status: string;
  visibility: string;
  moderationStatus: string;
  liveNow: boolean;
  /** Sunetul nou se mixează (re-procesare) / nu se poate mixa în acest clip. */
  soundMix?: "remixing" | "unavailable";
};

export type OwnedVideoDto = {
  id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  preview_url: string | null;
  playback_url: string | null;
  status: string;
  visibility: string;
  tags: string[] | null;
  allow_comments: boolean;
  allow_duet: boolean;
  allow_stitch: boolean;
  audio_track_id: number | null;
  /** „Titlu · Artist” al sunetului legat (null dacă nu există / nu mai e disponibil). */
  audio_track_label: string | null;
  /** Setările mixului (lib/video/sound-mix.ts), null = implicite. */
  sound_mix: { volume?: number; original_volume?: number; keep_original?: boolean; loop?: boolean } | null;
  product_refs: Array<{ product_id?: string }> | null;
  product_title: string | null;
  product_overlay_ms: number | null;
  /** Misiunea la care e înscris clipul (înscriere activă), din creator_mission_submissions. */
  mission_id: string | null;
  captions_enabled: boolean;
  scheduled_publish_at: string | null;
  duration_ms: number | null;
  session_id: string | null;
};

const VIDEOS = "/api/creator/videos";

export const videoApi = {
  get: (videoId: string) => call<{ video: OwnedVideoDto }>(`${VIDEOS}/${videoId}`).then((r) => r.video),
  patch: (videoId: string, body: VideoDetailsInput) => call<VideoPatchResult>(`${VIDEOS}/${videoId}`, json("PATCH", body)),
  reprocess: (videoId: string) => call<{ jobId: string }>(`${VIDEOS}/${videoId}/reprocess`, json("POST")),
  uploadCover: (videoId: string, jpeg: Blob) =>
    call<{ thumbnailUrl: string }>(`${VIDEOS}/${videoId}/cover`, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: jpeg,
    }),
  captions: (videoId: string) => call<{ tracks: CaptionTrack[] }>(`${VIDEOS}/${videoId}/captions`).then((r) => r.tracks),
  /** `held`: textul a fost semnalat de moderare → clipul așteaptă un moderator. */
  generateCaptions: (videoId: string, lang: string) =>
    call<{ track: CaptionTrack; held?: boolean }>(`${VIDEOS}/${videoId}/captions`, json("POST", { lang })),
  saveCaptions: (videoId: string, lang: string, segments: CaptionTrack["segments"]) =>
    call<{ track: CaptionTrack; held?: boolean }>(`${VIDEOS}/${videoId}/captions`, json("PUT", { lang, segments })),
};

export type TaggableProductDto = { id: string; title: string; image_url: string | null; price_cents: number; currency: string };
export type MissionDto = { id: string; slug: string; title: string; endsAt: string | null; prizeCents: number; currency: string };

export const pickerApi = {
  products: (q: string, signal?: AbortSignal) =>
    call<{ products: TaggableProductDto[] }>(`/api/creator/products/search?q=${encodeURIComponent(q)}`, { signal }).then(
      (r) => r.products,
    ),
  /** Misiunile deschise + cele la care userul are deja un clip (GET /api/missions/active). */
  missions: () => call<{ missions: MissionDto[]; joinedMissionIds: string[] }>("/api/missions/active"),
};
