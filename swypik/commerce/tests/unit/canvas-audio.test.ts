import { afterEach, describe, expect, it, vi } from "vitest";
import { createFilteredStream } from "@/lib/reels/canvas-pipeline";
class Stream {
  tracks: MediaStreamTrack[] = [];
  addTrack(track: MediaStreamTrack) { this.tracks.push(track); }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
}
function setup(captureFails = false) {
  const audio = { kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack;
  const camera = { kind: "video", stop: vi.fn(), getSettings: () => ({ width: 720, height: 1280 }) } as unknown as MediaStreamTrack;
  const derived = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
  const source = new Stream(); source.addTrack(camera); source.addTrack(audio);
  const output = new Stream(); output.addTrack(derived);
  const video = Object.assign(new EventTarget(), {
    srcObject: null as unknown, muted: false, playsInline: false, autoplay: false,
    videoWidth: 720, videoHeight: 1280, play: vi.fn(async () => {}), pause: vi.fn(),
  });
  const remove = vi.spyOn(video, "removeEventListener");
  const canvas = { width: 0, height: 0, getContext: () => ({ filter: "", drawImage: vi.fn() }), captureStream: () => {
    if (captureFails) throw new Error("unsupported");
    return output;
  }};
  vi.stubGlobal("document", { createElement: (tag: string) => tag === "video" ? video : canvas });
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 42));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return { source: source as unknown as MediaStream, audio, camera, derived, video, remove };
}
afterEach(() => vi.unstubAllGlobals());
describe("filtered camera audio and resource ownership", () => {
  it("preserves the original microphone track and stops only derived video", () => {
    const h = setup(); const result = createFilteredStream(h.source, "contrast(1.1)");
    expect(result.outputStream.getAudioTracks()).toEqual([h.audio]);
    expect(result.outputStream.getVideoTracks()).toEqual([h.derived]);
    result.stop(); result.stop();
    expect(h.derived.stop).toHaveBeenCalledOnce();
    expect(h.audio.stop).not.toHaveBeenCalled(); expect(h.camera.stop).not.toHaveBeenCalled();
    expect(h.video.srcObject).toBeNull(); expect(h.remove).toHaveBeenCalledWith("loadedmetadata", expect.any(Function));
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
  });
  it("cleans up the hidden player and render loop if canvas capture fails", () => {
    const h = setup(true);
    expect(() => createFilteredStream(h.source, "contrast(1.1)")).toThrow("unsupported");
    expect(h.video.pause).toHaveBeenCalledOnce(); expect(h.video.srcObject).toBeNull();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42); expect(h.audio.stop).not.toHaveBeenCalled();
    expect(h.remove).toHaveBeenCalledWith("loadedmetadata", expect.any(Function));
  });
});
