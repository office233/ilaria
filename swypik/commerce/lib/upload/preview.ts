import type { TrimRange } from "./trim";

/** Preview bounds only; the server applies the final trim to the uploaded media. */
export function bindTrimPreview(video: HTMLVideoElement, range: TrimRange): () => void {
  const start = range.startMs / 1000;
  const end = range.endMs / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) return () => {};
  let frame: number | null = null;
  const align = () => {
    if (video.readyState > 0 && (video.currentTime < start || video.currentTime >= end)) video.currentTime = start;
  };
  const stopFrame = () => { if (frame !== null) cancelAnimationFrame(frame); frame = null; };
  const tick = () => {
    frame = null;
    if (video.paused || video.ended) return;
    align();
    frame = requestAnimationFrame(tick);
  };
  const play = () => { align(); if (frame === null) frame = requestAnimationFrame(tick); };
  const time = () => { if (!video.paused) align(); };
  const ended = () => { stopFrame(); video.currentTime = start; };
  const hidden = () => { if (document.hidden) video.pause(); };
  align();
  if (!video.paused) play();
  video.addEventListener("play", play);
  video.addEventListener("pause", stopFrame);
  video.addEventListener("ended", ended);
  video.addEventListener("timeupdate", time);
  video.addEventListener("loadedmetadata", align);
  document.addEventListener("visibilitychange", hidden);
  return () => {
    stopFrame();
    video.removeEventListener("play", play);
    video.removeEventListener("pause", stopFrame);
    video.removeEventListener("ended", ended);
    video.removeEventListener("timeupdate", time);
    video.removeEventListener("loadedmetadata", align);
    document.removeEventListener("visibilitychange", hidden);
  };
}
