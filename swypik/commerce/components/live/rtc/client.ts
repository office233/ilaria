/**
 * Utilitare WebRTC pentru Live (browser). Semnalizarea trece prin API-ul
 * nostru (/api/live/streams/[id]/{ice,publish,watch,heartbeat}); browserul nu
 * vede niciodată credențialele SFU.
 */

export type LivePulse = { status: "scheduled" | "live" | "ended" | "failed"; viewers: number; publishedAt: string | null };

export class LiveRtcError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "LiveRtcError";
  }
}

const ICE_GATHER_TIMEOUT_MS = 3000;
const CONNECT_TIMEOUT_MS = 15000;

export async function liveApi<T>(streamId: string, path: string, init: { method: "GET" | "POST" | "PUT"; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/live/streams/${streamId}/${path}`, {
      method: init.method,
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    throw new LiveRtcError("network");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new LiveRtcError(data.error ?? String(res.status));
  return data;
}

export async function createPeerConnection(streamId: string): Promise<RTCPeerConnection> {
  const { iceServers } = await liveApi<{ iceServers: RTCIceServer[] }>(streamId, "ice", { method: "GET" });
  return new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
}

/** Așteaptă adunarea candidaților ICE (plafonat: SFU-ul are și candidați proprii). */
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = ICE_GATHER_TIMEOUT_MS): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => pc.iceGatheringState === "complete" && done();
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

export function waitForConnected(pc: RTCPeerConnection, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
  if (pc.connectionState === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      pc.removeEventListener("connectionstatechange", onChange);
    };
    const onChange = () => {
      if (pc.connectionState === "connected") {
        cleanup();
        resolve();
      } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        cleanup();
        reject(new LiveRtcError("connection_failed"));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new LiveRtcError("connection_timeout"));
    }, timeoutMs);
    pc.addEventListener("connectionstatechange", onChange);
  });
}

export function localSdp(pc: RTCPeerConnection): { type: "offer" | "answer"; sdp: string } {
  const desc = pc.localDescription;
  if (!desc || (desc.type !== "offer" && desc.type !== "answer")) throw new LiveRtcError("no_local_description");
  return { type: desc.type, sdp: desc.sdp };
}

export function errorCode(err: unknown): string {
  if (err instanceof LiveRtcError) return err.code;
  if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")) return "permission_denied";
  if (err instanceof DOMException && err.name === "NotFoundError") return "no_device";
  return "unknown";
}
