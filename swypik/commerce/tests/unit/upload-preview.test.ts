import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindTrimPreview } from "@/lib/upload/preview";
import { seekTo } from "@/lib/upload/media";

class Video extends EventTarget {
  currentTime = 0;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 1;
  pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event("pause")); });
  asVideo() { return this as unknown as HTMLVideoElement; }
}
let doc: EventTarget & { hidden: boolean };
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
beforeEach(() => {
  vi.useFakeTimers();
  doc = Object.assign(new EventTarget(), { hidden: false });
  frames = new Map(); nextFrame = 0;
  vi.stubGlobal("document", doc);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.set(++nextFrame, fn); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("audible video preview bounds", () => {
  it("aligns to the trim and loops playback without muting or changing a paused cover frame", () => {
    const video = new Video();
    const cleanup = bindTrimPreview(video.asVideo(), { startMs: 2000, endMs: 5000 });
    expect(video.currentTime).toBe(2);
    video.currentTime = 5;
    video.dispatchEvent(new Event("timeupdate"));
    expect(video.currentTime).toBe(5);
    video.paused = false; video.dispatchEvent(new Event("play"));
    expect(video.currentTime).toBe(2);
    video.currentTime = 5.05; video.dispatchEvent(new Event("timeupdate"));
    expect(video.currentTime).toBe(2);
    cleanup(); expect(frames.size).toBe(0);
  });
  it("pauses when hidden and removes visibility and time listeners on cleanup", () => {
    const video = new Video(); video.paused = false;
    const cleanup = bindTrimPreview(video.asVideo(), { startMs: 0, endMs: 5000 });
    doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange"));
    expect(video.pause).toHaveBeenCalledOnce(); expect(frames.size).toBe(0);
    cleanup();
    doc.dispatchEvent(new Event("visibilitychange")); expect(video.pause).toHaveBeenCalledOnce();
    video.paused = false; video.currentTime = 6; video.dispatchEvent(new Event("timeupdate"));
    expect(video.currentTime).toBe(6);
  });
  it("aligns a new range while paused and rejects invalid ranges without scheduling", () => {
    const video = new Video();
    bindTrimPreview(video.asVideo(), { startMs: 4000, endMs: 3000 })();
    expect(video.currentTime).toBe(0); expect(frames.size).toBe(0);
    bindTrimPreview(video.asVideo(), { startMs: 1000, endMs: 3000 })();
    expect(video.currentTime).toBe(1);
  });
});
describe("cover frame seek", () => {
  it("waits for seek completion rather than reading the previous frame", async () => {
    const video = new Video(); const complete = vi.fn();
    const result = seekTo(video.asVideo(), 2).then(complete);
    await Promise.resolve(); expect(complete).not.toHaveBeenCalled();
    video.dispatchEvent(new Event("seeked")); await result;
    expect(complete).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("times out instead of leaving the cover button permanently busy", async () => {
    const video = new Video();
    const result = expect(seekTo(video.asVideo(), 2, 100)).rejects.toThrow("seek_timeout");
    await vi.advanceTimersByTimeAsync(100); await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects a failed decoder and cleans up the timeout", async () => {
    const video = new Video(); const result = seekTo(video.asVideo(), 2);
    video.dispatchEvent(new Event("error"));
    await expect(result).rejects.toThrow("seek_failed");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("handles the current frame immediately and rejects invalid times", async () => {
    const video = new Video();
    await expect(seekTo(video.asVideo(), 0)).resolves.toBeUndefined();
    await expect(seekTo(video.asVideo(), NaN)).rejects.toThrow("invalid_seek");
    expect(vi.getTimerCount()).toBe(0);
  });
});
