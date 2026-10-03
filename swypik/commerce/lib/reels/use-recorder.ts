"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "@/lib/logger";

export type RecorderState =
  | "idle"
  | "countdown"
  | "recording"
  | "paused"
  | "stopping"
  | "preview";

export interface UseRecorderOptions {
  maxDurationMs: number;
  onComplete: (blob: Blob, durationMs: number) => void;
  onError?: () => void;
  /**
   * Opțional: returnează stream-ul efectiv folosit pentru înregistrare.
   * Default = stream-ul camerei. Folosit pentru a injecta canvas pipeline cu filtre.
   * Cleanup-ul (dacă există) e responsabilitatea consumer-ului.
   */
  getRecordingStream?: (cameraStream: MediaStream) => MediaStream;
  /** Secunde pentru countdown (default 3). 0 = skip countdown. */
  countdownSeconds?: number;
}

export interface SegmentMarker {
  /** Cumulative ms la momentul pause (= sfârșitul segmentului) */
  endMs: number;
}

export interface UseRecorderReturn {
  state: RecorderState;
  elapsedMs: number;
  countdownValue: number;
  mimeType: string | null;
  error: "unsupported" | "start_failed" | "record_failed" | "empty" | null;
  /** Boundary markers între segmente (după fiecare pause). Ultimul segment e cel în curs. */
  segments: SegmentMarker[];
  startCountdown: () => void;
  start: () => void;
  pause: () => void;
  resume: () => void;
  /** Finalizează înregistrarea (echivalent cu stop) și expune blob-ul via onComplete */
  stop: () => void;
  reset: () => void;
}

const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1,mp4a",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function pickSupportedMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Hook pentru înregistrare video prin MediaRecorder cu countdown 3-2-1
 * și auto-stop la maxDurationMs.
 */
export function useRecorder(
  stream: MediaStream | null,
  opts: UseRecorderOptions,
): UseRecorderReturn {
  const { maxDurationMs, onComplete, getRecordingStream, countdownSeconds } = opts;

  const [state, setState] = useState<RecorderState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [countdownValue, setCountdownValue] = useState(0);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [error, setError] = useState<UseRecorderReturn["error"]>(null);
  const [segments, setSegments] = useState<SegmentMarker[]>([]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  /** Timestamp când a început segmentul curent (pentru a calcula durata sa) */
  const segmentStartTsRef = useRef<number>(0);
  /** Cumulul ms al segmentelor finalizate înainte de segmentul curent */
  const accumMsRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(opts.onError);
  useEffect(() => { onErrorRef.current = opts.onError; }, [opts.onError]);
  const maxRef = useRef(maxDurationMs);
  const getStreamRef = useRef(getRecordingStream);
  const countdownSecRef = useRef(countdownSeconds ?? 3);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);
  useEffect(() => {
    maxRef.current = maxDurationMs;
  }, [maxDurationMs]);
  useEffect(() => {
    getStreamRef.current = getRecordingStream;
  }, [getRecordingStream]);
  useEffect(() => {
    countdownSecRef.current = countdownSeconds ?? 3;
  }, [countdownSeconds]);

  const clearTick = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearTimeout(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (rec.state === "inactive") return;
    // Capturează durata segmentului curent dacă era activ
    if (rec.state === "recording") {
      accumMsRef.current += Date.now() - segmentStartTsRef.current;
    }
    setState("stopping");
    // Forțează flush-ul ultimului chunk înainte de stop (esențial Safari/iOS)
    try {
      rec.requestData();
    } catch {
      /* ignore */
    }
    try {
      rec.stop();
    } catch {
      /* ignore */
    }
    clearTick();
  }, [clearTick]);

  const start = useCallback(() => {
    if (!stream) return;
    if (recorderRef.current && recorderRef.current.state !== "inactive") return;
    setError(null);
    if (typeof MediaRecorder === "undefined") {
      setError("unsupported");
      onErrorRef.current?.();
      setState("idle");
      return;
    }
    const picked = pickSupportedMime();
    setMimeType(picked);
    let rec: MediaRecorder;
    try {
      const fn = getStreamRef.current;
      const recordingStream = fn ? fn(stream) : stream;
      try {
        rec = picked
          ? new MediaRecorder(recordingStream, { mimeType: picked })
          : new MediaRecorder(recordingStream);
      } catch {
        rec = new MediaRecorder(recordingStream);
      }
    } catch {
      setError("start_failed");
      onErrorRef.current?.();
      setState("idle");
      return;
    }
    recorderRef.current = rec;
    chunksRef.current = [];
    accumMsRef.current = 0;
    setSegments([]);

    let failed = false;
    rec.onerror = () => {
      failed = true;
      clearTick();
      setError("record_failed");
      onErrorRef.current?.();
      setState("idle");
      try { if (rec.state !== "inactive") rec.stop(); } catch { /* already stopped */ }
    };
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      clearTick();
      if (failed) return;
      const finalMime = rec.mimeType || picked || "video/webm";
      const blob = new Blob(chunksRef.current, { type: finalMime });
      const finalElapsed = accumMsRef.current;
      setElapsedMs(finalElapsed);
      if (blob.size === 0) {
        // Niciun chunk capturat — resetăm și marcăm idle ca să nu rămână UI blocat
        logger.error({ chunks: chunksRef.current.length }, "[recorder] blob gol");
        setError("empty");
      onErrorRef.current?.();
        setState("idle");
        return;
      }
      setState("preview");
      onCompleteRef.current(blob, finalElapsed);
    };

    try {
      rec.start(250); // timeslice pentru chunk-uri intermediare
    } catch {
      try { rec.start(); } catch {
        failed = true;
        rec.onstop = null;
        rec.ondataavailable = null;
        rec.onerror = null;
        recorderRef.current = null;
        setError("start_failed");
      onErrorRef.current?.();
        setState("idle");
        return;
      }
    }
    segmentStartTsRef.current = Date.now();
    setElapsedMs(0);
    setState("recording");

    clearTick();
    tickRef.current = setInterval(() => {
      const cur = accumMsRef.current + (Date.now() - segmentStartTsRef.current);
      setElapsedMs(cur);
      if (cur >= maxRef.current) {
        // auto-stop la max duration
        const r = recorderRef.current;
        if (r && r.state !== "inactive") {
          if (r.state === "recording") {
            accumMsRef.current += Date.now() - segmentStartTsRef.current;
          }
          setState("stopping");
          try {
            r.stop();
          } catch {
            /* ignore */
          }
        }
        clearTick();
      }
    }, 200);
  }, [stream, clearTick]);

  const pause = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "recording") return;
    try {
      rec.pause();
    } catch {
      return;
    }
    const segDur = Date.now() - segmentStartTsRef.current;
    accumMsRef.current += segDur;
    setSegments((prev) => [...prev, { endMs: accumMsRef.current }]);
    setElapsedMs(accumMsRef.current);
    setState("paused");
    clearTick();
  }, [clearTick]);

  const resume = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "paused") return;
    try {
      rec.resume();
    } catch {
      return;
    }
    segmentStartTsRef.current = Date.now();
    setState("recording");
    clearTick();
    tickRef.current = setInterval(() => {
      const cur = accumMsRef.current + (Date.now() - segmentStartTsRef.current);
      setElapsedMs(cur);
      if (cur >= maxRef.current) {
        const r = recorderRef.current;
        if (r && r.state !== "inactive") {
          if (r.state === "recording") {
            accumMsRef.current += Date.now() - segmentStartTsRef.current;
          }
          setState("stopping");
          try {
            r.stop();
          } catch {
            /* ignore */
          }
        }
        clearTick();
      }
    }, 200);
  }, [clearTick]);

  const startCountdown = useCallback(() => {
    if (!stream) return;
    setError(null);
    clearCountdown();
    const secs = Math.max(0, Math.floor(countdownSecRef.current));
    if (secs === 0) {
      start();
      return;
    }
    setState("countdown");
    setCountdownValue(secs);

    const step = (n: number) => {
      if (n <= 0) {
        setCountdownValue(0);
        start();
        return;
      }
      setCountdownValue(n);
      countdownRef.current = setTimeout(() => step(n - 1), 1000);
    };
    // afișează `secs` imediat, apoi tick la fiecare secundă
    countdownRef.current = setTimeout(() => step(secs - 1), 1000);
  }, [stream, start, clearCountdown]);

  const reset = useCallback(() => {
    clearCountdown();
    clearTick();
    const rec = recorderRef.current;
    if (rec) { rec.onstop = null; rec.ondataavailable = null; rec.onerror = null; }
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    recorderRef.current = null;
    chunksRef.current = [];
    accumMsRef.current = 0;
    segmentStartTsRef.current = 0;
    setSegments([]);
    setElapsedMs(0);
    setCountdownValue(0);
    setError(null);
    setState("idle");
  }, [clearCountdown, clearTick]);

  useEffect(() => {
    return () => {
      clearCountdown();
      clearTick();
      const rec = recorderRef.current;
      if (rec) { rec.onstop = null; rec.ondataavailable = null; rec.onerror = null; }
      if (rec && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      }
    };
  }, [clearCountdown, clearTick]);

  return {
    state,
    elapsedMs,
    countdownValue,
    mimeType,
    error,
    segments,
    startCountdown,
    start,
    pause,
    resume,
    stop,
    reset,
  };
}
