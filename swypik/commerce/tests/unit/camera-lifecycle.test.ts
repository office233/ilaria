import { describe, expect, it, vi } from "vitest";
import { CameraRequestLifecycle } from "@/lib/reels/camera-lifecycle";

function stream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { tracks, getTracks: () => tracks };
}

describe("camera stream ownership", () => {
  it("stops every track when permission resolves after unmount", async () => {
    const lifecycle = new CameraRequestLifecycle<ReturnType<typeof stream>>();
    lifecycle.activate();
    const request = lifecycle.begin()!;
    const late = stream();
    lifecycle.dispose();
    expect(lifecycle.accept(request, late)).toBe(false);
    for (const track of late.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("keeps the remounted request when an earlier permission prompt finishes", () => {
    const lifecycle = new CameraRequestLifecycle<ReturnType<typeof stream>>();
    lifecycle.activate();
    const oldRequest = lifecycle.begin()!;
    lifecycle.dispose();
    lifecycle.activate();
    const currentRequest = lifecycle.begin()!;
    const current = stream();
    expect(lifecycle.accept(currentRequest, current)).toBe(true);
    const stale = stream();
    expect(lifecycle.accept(oldRequest, stale)).toBe(false);
    expect(lifecycle.reject(oldRequest)).toBe(false);
    for (const track of current.tracks) expect(track.stop).not.toHaveBeenCalled();
    for (const track of stale.tracks) expect(track.stop).toHaveBeenCalledOnce();
    lifecycle.dispose();
    for (const track of current.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("locks repeated switch requests until the current request settles", () => {
    const lifecycle = new CameraRequestLifecycle<ReturnType<typeof stream>>();
    lifecycle.activate();
    const first = lifecycle.begin()!;
    expect(lifecycle.begin()).toBeNull();
    expect(lifecycle.isPending).toBe(true);
    expect(lifecycle.reject(first)).toBe(true);
    expect(lifecycle.isPending).toBe(false);
    expect(lifecycle.begin()).not.toBeNull();
  });

  it("does not let a stale failure unlock a newer pending request", () => {
    const lifecycle = new CameraRequestLifecycle<ReturnType<typeof stream>>();
    lifecycle.activate();
    const old = lifecycle.begin()!;
    lifecycle.dispose();
    lifecycle.activate();
    lifecycle.begin();
    expect(lifecycle.reject(old)).toBe(false);
    expect(lifecycle.isPending).toBe(true);
    expect(lifecycle.begin()).toBeNull();
  });

  it("releases camera and microphone once on switch and ignores repeated cleanup", () => {
    const lifecycle = new CameraRequestLifecycle<ReturnType<typeof stream>>();
    lifecycle.activate();
    const media = stream();
    lifecycle.accept(lifecycle.begin()!, media);
    lifecycle.release();
    lifecycle.dispose();
    lifecycle.dispose();
    for (const track of media.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(lifecycle.begin()).toBeNull();
  });
});
