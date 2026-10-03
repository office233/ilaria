"use client";

/**
 * Canvas pipeline pentru "baking" filtre vizuale în stream-ul de înregistrare.
 *
 * Folosit doar când utilizatorul selectează un filtru != "none". Altfel,
 * MediaRecorder primește direct stream-ul camerei (path simplu, mai puțin
 * costisitor energetic pe mobil).
 *
 * Strategie:
 *  1. Un <video> hidden joacă MediaStream-ul camerei (sursă)
 *  2. Un <canvas> off-DOM redă fiecare frame cu `ctx.filter = filterCss`
 *  3. `canvas.captureStream(fps)` produce un VideoTrack filtrat
 *  4. Track-ul audio original este reatașat pentru un MediaStream complet
 */

export interface FilteredPipeline {
  /** Stream-ul filtrat — feed-uit la MediaRecorder */
  outputStream: MediaStream;
  /** Eliberează RAF + revocă track-urile derivate (NU oprește camera sursă) */
  stop: () => void;
}

/**
 * Creează un MediaStream filtrat din `source` aplicând `filterCss`.
 *
 * @param source — Stream-ul live de la cameră (cu video + audio tracks)
 * @param filterCss — Valoare validă pentru `ctx.filter` (ex. "saturate(1.5) contrast(1.1)")
 * @param fps — Frame rate țintă pentru capture (24 e suficient pentru reels)
 */
export function createFilteredStream(
  source: MediaStream,
  filterCss: string,
  fps = 30,
): FilteredPipeline {
  // 1. Hidden video element care joacă sursa
  const video = document.createElement("video");
  video.srcObject = source;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  // forțează play (iOS necesită gesture, dar suntem deja într-un click context)
  void video.play().catch(() => {
    /* best effort — dacă pică, frame-urile vor fi negre dar nu crash */
  });

  // 2. Canvas off-DOM
  const canvas = document.createElement("canvas");
  const videoTrack = source.getVideoTracks()[0];
  const settings = videoTrack?.getSettings?.() || {};
  canvas.width = settings.width || 720;
  canvas.height = settings.height || 1280;

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    video.pause();
    video.srcObject = null;
    throw new Error("Canvas 2D context indisponibil pentru pipeline filtru.");
  }

  // Adjust canvas la dimensiunile reale ale video-ului când e ready
  let dimsLocked = false;
  const lockDims = () => {
    if (dimsLocked) return;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      dimsLocked = true;
    }
  };
  video.addEventListener("loadedmetadata", lockDims);

  // 3. Render loop
  let rafId: number | null = null;
  let stopped = false;
  const frameIntervalMs = 1000 / fps;
  let lastDrawTs = 0;

  const draw = (ts: number) => {
    if (stopped) return;
    if (ts - lastDrawTs >= frameIntervalMs) {
      lockDims();
      try {
        ctx.filter = filterCss;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch {
        /* ignore tranziție stream/video swap */
      }
      lastDrawTs = ts;
    }
    rafId = requestAnimationFrame(draw);
  };
  rafId = requestAnimationFrame(draw);

  // 4. Capture canvas + reatașează audio
  let canvasStream: MediaStream;
  try {
    canvasStream = canvas.captureStream(fps);
  } catch (error) {
    stopped = true;
    video.removeEventListener("loadedmetadata", lockDims);
    if (rafId !== null) cancelAnimationFrame(rafId);
    video.pause();
    video.srcObject = null;
    throw error;
  }
  const outputStream = new MediaStream();
  canvasStream.getVideoTracks().forEach((t) => outputStream.addTrack(t));
  source.getAudioTracks().forEach((t) => outputStream.addTrack(t));

  const stop = () => {
    if (stopped) return;
    stopped = true;
    video.removeEventListener("loadedmetadata", lockDims);
    if (rafId !== null) cancelAnimationFrame(rafId);
    canvasStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    try {
      video.pause();
      video.srcObject = null;
    } catch {
      /* ignore */
    }
  };

  return { outputStream, stop };
}
