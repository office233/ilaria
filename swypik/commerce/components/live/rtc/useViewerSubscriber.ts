"use client";

import { useEffect, useState } from "react";
import { createPeerConnection, errorCode, liveApi, localSdp, waitForConnected, waitForIceGathering, type LivePulse } from "./client";
import { useHeartbeat } from "./useHeartbeat";

export type ViewerState =
  | { status: "idle" | "connecting" }
  | { status: "playing"; sessionId: string }
  | { status: "error"; code: string };

type WatchResponse = { sessionId: string; offer: RTCSessionDescriptionInit; heartbeatMs: number };

/**
 * Spectatorul trage track-urile gazdei: /watch (serverul creează sesiunea SFU și
 * cere track-urile) → oferta SFU → răspunsul browserului → PUT /watch → conectat
 * → heartbeat (numărat ca spectator). Doar recepție.
 */
export function useViewerSubscriber(streamId: string, enabled: boolean, attempt: number, onPulse: (pulse: LivePulse) => void) {
  const [state, setState] = useState<ViewerState>({ status: "idle" });
  const [media, setMedia] = useState<MediaStream | null>(null);
  const [heartbeatMs, setHeartbeatMs] = useState(7000);

  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    const remote = new MediaStream();
    setState({ status: "connecting" });

    (async () => {
      pc = await createPeerConnection(streamId);
      pc.addEventListener("track", (e) => {
        remote.addTrack(e.track);
        setMedia(new MediaStream(remote.getTracks()));
      });
      const res = await liveApi<WatchResponse>(streamId, "watch", { method: "POST" });
      if (cancelled) return;
      await pc.setRemoteDescription(res.offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIceGathering(pc);
      await liveApi(streamId, "watch", { method: "PUT", body: { sessionId: res.sessionId, answer: localSdp(pc) } });
      await waitForConnected(pc);
      if (cancelled) return;
      setHeartbeatMs(res.heartbeatMs);
      setState({ status: "playing", sessionId: res.sessionId });
      pc.addEventListener("connectionstatechange", () => {
        if (pc?.connectionState === "failed") setState({ status: "error", code: "connection_failed" });
      });
    })().catch((err: unknown) => {
      if (!cancelled) setState({ status: "error", code: errorCode(err) });
    });

    return () => {
      cancelled = true;
      pc?.close();
      remote.getTracks().forEach((t) => t.stop());
      setMedia(null);
    };
  }, [streamId, enabled, attempt]);

  const sessionId = state.status === "playing" ? state.sessionId : null;
  useHeartbeat(streamId, "viewer", sessionId, heartbeatMs, onPulse, (code) => setState({ status: "error", code }));

  return { state, media };
}
