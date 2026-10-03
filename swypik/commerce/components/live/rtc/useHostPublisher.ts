"use client";

import { useCallback, useEffect, useState } from "react";
import { createPeerConnection, errorCode, liveApi, localSdp, waitForConnected, waitForIceGathering, type LivePulse } from "./client";
import { useHeartbeat } from "./useHeartbeat";

export type HostPublisherState =
  | { status: "idle" | "starting" }
  | { status: "publishing"; sessionId: string }
  | { status: "error"; code: string };

type PublishResponse = { sessionId: string; answer: RTCSessionDescriptionInit; heartbeatMs: number };

const CAMERA: MediaStreamConstraints = {
  video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 1280 }, frameRate: { ideal: 30 } },
  audio: { echoCancellation: true, noiseSuppression: true },
};

/**
 * Publicarea gazdei pe Cloudflare Realtime SFU: cameră + microfon →
 * RTCPeerConnection (sendonly) → ofertă → /publish (serverul vorbește cu SFU-ul)
 * → răspuns → conectat → heartbeat (primul puls cu media activă face streamul live).
 * `attempt` incrementat = reconectare (sesiune nouă).
 */
export function useHostPublisher(
  streamId: string,
  enabled: boolean,
  attempt: number,
  onPulse: (pulse: LivePulse) => void,
) {
  const [state, setState] = useState<HostPublisherState>({ status: "idle" });
  const [media, setMedia] = useState<MediaStream | null>(null);
  const [heartbeatMs, setHeartbeatMs] = useState(7000);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);

  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let local: MediaStream | null = null;
    setState({ status: "starting" });

    (async () => {
      local = await navigator.mediaDevices.getUserMedia(CAMERA);
      if (cancelled) return;
      setMedia(local);
      setMicOn(true);
      setCamOn(true);
      pc = await createPeerConnection(streamId);
      const tracks = local.getTracks().map((track) => ({
        track,
        transceiver: pc!.addTransceiver(track, { direction: "sendonly" }),
      }));
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIceGathering(pc);
      const res = await liveApi<PublishResponse>(streamId, "publish", {
        method: "POST",
        body: {
          offer: localSdp(pc),
          tracks: tracks.map((t) => ({ mid: t.transceiver.mid, trackName: t.track.kind === "video" ? "video" : "audio" })),
        },
      });
      if (cancelled) return;
      await pc.setRemoteDescription(res.answer);
      await waitForConnected(pc);
      if (cancelled) return;
      setHeartbeatMs(res.heartbeatMs);
      setState({ status: "publishing", sessionId: res.sessionId });
      pc.addEventListener("connectionstatechange", () => {
        if (pc?.connectionState === "failed") setState({ status: "error", code: "connection_failed" });
      });
    })().catch((err: unknown) => {
      if (!cancelled) setState({ status: "error", code: errorCode(err) });
    });

    return () => {
      cancelled = true;
      pc?.close();
      local?.getTracks().forEach((t) => t.stop());
      setMedia(null);
    };
  }, [streamId, enabled, attempt]);

  const sessionId = state.status === "publishing" ? state.sessionId : null;
  useHeartbeat(streamId, "host", sessionId, heartbeatMs, onPulse, (code) => setState({ status: "error", code }));

  const toggleMic = useCallback(() => {
    media?.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
    setMicOn((v) => !v);
  }, [media]);
  const toggleCam = useCallback(() => {
    media?.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
    setCamOn((v) => !v);
  }, [media]);

  return { state, media, micOn, camOn, toggleMic, toggleCam };
}
