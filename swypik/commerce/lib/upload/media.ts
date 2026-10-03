/**
 * Utilitare media în browser: citirea duratei/dimensiunilor unui fișier
 * înainte de upload și capturarea unui cadru ca JPEG (coperta aleasă).
 */

export type ProbedFile = { durationMs: number; width: number; height: number };

/** null dacă browserul nu poate decoda fișierul (ex. HEVC pe Chrome) — workerul îl validează oricum. */
export function probeVideoFile(file: Blob, timeoutMs = 10_000): Promise<ProbedFile | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    let settled = false;
    const finish = (value: ProbedFile | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.onloadedmetadata = () => {
      const d = video.duration;
      // MediaRecorder (webm) raportează uneori Infinity până la un seek.
      if (!Number.isFinite(d)) {
        video.currentTime = Number.MAX_SAFE_INTEGER;
        video.ontimeupdate = () => {
          video.ontimeupdate = null;
          finish(Number.isFinite(video.duration) ? dims(video) : null);
        };
        return;
      }
      finish(dims(video));
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

function dims(video: HTMLVideoElement): ProbedFile {
  return { durationMs: Math.round(video.duration * 1000), width: video.videoWidth, height: video.videoHeight };
}

/** Capturează cadrul curent al unui <video> ca JPEG (latura scurtă ≤ maxShortSide). */
export function captureFrame(video: HTMLVideoElement, maxShortSide = 720, quality = 0.85): Promise<Blob> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return Promise.reject(new Error("no_frame"));
  const scale = Math.min(1, maxShortSide / Math.min(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("no_canvas"));
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode_failed"))), "image/jpeg", quality),
  );
}

/** Mută playerul la `seconds` și așteaptă cadrul. */
export function seekTo(video: HTMLVideoElement, seconds: number, timeoutMs = 4000): Promise<void> {
  if (!Number.isFinite(seconds) || seconds < 0) return Promise.reject(new Error("invalid_seek"));
  return new Promise((resolve, reject) => {
    if (!video.seeking && Math.abs(video.currentTime - seconds) < 0.01) return resolve();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", failed);
      video.removeEventListener("emptied", failed);
      if (error) reject(error);
      else resolve();
    };
    const done = () => finish();
    const failed = () => finish(new Error("seek_failed"));
    const timer = setTimeout(() => finish(new Error("seek_timeout")), timeoutMs);
    video.addEventListener("seeked", done);
    video.addEventListener("error", failed);
    video.addEventListener("emptied", failed);
    try { video.currentTime = seconds; } catch { failed(); }
  });
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
