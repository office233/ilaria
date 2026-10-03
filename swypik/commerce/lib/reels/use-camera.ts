"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CameraRequestLifecycle } from "./camera-lifecycle";

export type CameraFacing = "user" | "environment";
export type CameraStatus =
  | "idle"
  | "requesting"
  | "ready"
  | "denied"
  | "unavailable";

export interface UseCameraOptions {
  facing: CameraFacing;
}

export interface UseCameraReturn {
  stream: MediaStream | null;
  error: string | null;
  status: CameraStatus;
  facing: CameraFacing;
  switchFacing: () => Promise<void>;
  attachVideo: (el: HTMLVideoElement | null) => void;
}

/**
 * Cere acces la cameră (mobile-first, portret 9:16) și expune stream-ul.
 * Curăță automat track-urile la unmount sau la switch.
 */
export function useCamera(opts: UseCameraOptions): UseCameraReturn {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [facing, setFacing] = useState<CameraFacing>(opts.facing);

  const streamRef = useRef<MediaStream | null>(null);
  const facingRef = useRef<CameraFacing>(opts.facing);
  const lifecycleRef = useRef(new CameraRequestLifecycle<MediaStream>());
  const videoElRef = useRef<HTMLVideoElement | null>(null);

  const stopCurrent = useCallback(() => {
    lifecycleRef.current.release();
    streamRef.current = null;
    // iOS Safari: trebuie să detașăm explicit stream-ul de elementul video
    // altfel rămâne pinned și camera nu poate fi re-acquired.
    if (videoElRef.current) {
      try {
        videoElRef.current.srcObject = null;
      } catch {
        /* ignore */
      }
    }
  }, []);

  const acquire = useCallback(async (mode: CameraFacing) => {
    const lifecycle = lifecycleRef.current;
    const request = lifecycle.begin();
    if (request === null) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      lifecycle.reject(request);
      setStatus("unavailable");
      setError("Camera nu este disponibilă pe acest dispozitiv.");
      return;
    }

    setStatus("requesting");
    setError(null);

    try {
      // NU forțăm aspectRatio — webcam-ul desktop e landscape (4:3 sau 16:9).
      // Dacă cerem 9:16, browserul cropează agresiv ⇒ "ultra zoom".
      // Lăsăm rezoluția nativă, iar UI-ul se adaptează cu object-contain.
      const ms = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: mode,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      // An old permission prompt may finish after unmount or a remount.
      // Its tracks must be stopped without updating React or the video element.
      if (!lifecycle.accept(request, ms)) return;
      streamRef.current = ms;
      setStream(ms);
      setStatus("ready");

      // re-attach if a video element was registered before stream arrived
      if (videoElRef.current) {
        videoElRef.current.srcObject = ms;
        videoElRef.current.muted = true;
      }
    } catch (e: unknown) {
      if (!lifecycle.reject(request)) return;
      const err = e as { name?: string; message?: string };
      if (err?.name === "NotAllowedError" || err?.name === "SecurityError") {
        setStatus("denied");
        setError("Acces refuzat la cameră.");
      } else if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") {
        setStatus("unavailable");
        setError("Nu s-a găsit o cameră compatibilă.");
      } else {
        setStatus("unavailable");
        setError(err?.message || "Eroare necunoscută la accesarea camerei.");
      }
    }
  }, []);

  // initial mount
  useEffect(() => {
    const lifecycle = lifecycleRef.current;
    lifecycle.activate();
    void acquire(facingRef.current);
    return () => {
      lifecycle.dispose();
      stopCurrent();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchFacing = useCallback(async () => {
    if (lifecycleRef.current.isPending) return;
    const next: CameraFacing = facingRef.current === "user" ? "environment" : "user";
    stopCurrent();
    setStream(null);
    facingRef.current = next;
    setFacing(next);
    await acquire(next);
  }, [acquire, stopCurrent]);

  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el;
    if (el && streamRef.current) {
      // IDEMPOTENT: re-asignarea srcObject la fiecare render cauzează flicker
      // pe Chrome/Safari (videoul se reîncarcă). Setăm DOAR dacă diferă.
      if (el.srcObject !== streamRef.current) {
        el.srcObject = streamRef.current;
      }
      if (!el.muted) el.muted = true;
    }
  }, []);

  return { stream, error, status, facing, switchFacing, attachVideo };
}
