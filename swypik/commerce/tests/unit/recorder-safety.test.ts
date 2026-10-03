import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ cleanups: [] as (() => void)[], updates: [] as unknown[] }));
vi.mock("react", () => ({
  useState: (value: unknown) => [value, (next: unknown) => harness.updates.push(next)],
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void | (() => void)) => { const cleanup = fn(); if (cleanup) harness.cleanups.push(cleanup); },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
import { useRecorder } from "@/lib/reels/use-recorder";
let instances: FakeRecorder[] = [];
let failStart = false;
class FakeRecorder {
  static isTypeSupported() { return true; }
  state = "inactive";
  mimeType = "video/webm";
  onstop: (() => void) | null = null;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { instances.push(this); }
  start() { if (failStart) throw new Error("device failed"); this.state = "recording"; }
  stop() { this.state = "inactive"; this.onstop?.(); }
  requestData() { this.ondataavailable?.({ data: new Blob(["frame"], { type: this.mimeType }) }); }
}
const stream = {} as MediaStream;
beforeEach(() => {
  harness.cleanups = []; harness.updates = []; instances = []; failStart = false;
  vi.useFakeTimers(); vi.stubGlobal("MediaRecorder", FakeRecorder);
});
afterEach(() => { harness.cleanups.forEach((fn) => fn()); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("camera recorder failure and cancellation", () => {
  it("unsupported browser reports an error instead of throwing", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const complete = vi.fn(); const r = useRecorder(stream, { maxDurationMs: 1000, onComplete: complete });
    expect(() => r.start()).not.toThrow(); expect(harness.updates).toContain("unsupported"); expect(complete).not.toHaveBeenCalled();
  });
  it("filter pipeline failure is visible and does not silently record different output", () => {
    const r = useRecorder(stream, { maxDurationMs: 1000, onComplete: vi.fn(), getRecordingStream: () => { throw new Error("canvas failed"); } });
    expect(() => r.start()).not.toThrow(); expect(harness.updates).toContain("start_failed"); expect(instances).toHaveLength(0);
  });
  it("both recorder start attempts failing leave no running recorder", () => {
    failStart = true; const r = useRecorder(stream, { maxDurationMs: 1000, onComplete: vi.fn() });
    expect(() => r.start()).not.toThrow(); expect(harness.updates).toContain("start_failed"); expect(instances[0].onstop).toBeNull();
  });
  it("leaving the camera does not complete or upload a partial recording", () => {
    const complete = vi.fn(); const r = useRecorder(stream, { maxDurationMs: 1000, onComplete: complete });
    r.start(); instances[0].requestData(); harness.cleanups.forEach((fn) => fn());
    expect(instances[0].state).toBe("inactive"); expect(complete).not.toHaveBeenCalled();
  });
  it("reset discards captured content without completing it", () => {
    const complete = vi.fn(); const r = useRecorder(stream, { maxDurationMs: 1000, onComplete: complete });
    r.start(); instances[0].requestData(); r.reset(); expect(complete).not.toHaveBeenCalled();
  });
  it("normal completion uses the recorder's actual container type", () => {
    const complete = vi.fn(); const r = useRecorder(stream, { maxDurationMs: 1000, onComplete: complete });
    r.start(); r.stop(); expect(complete).toHaveBeenCalledTimes(1); expect(complete.mock.calls[0][0].type).toBe("video/webm");
  });
  it("device errors never complete corrupted recording data", () => {
    const complete = vi.fn(); const r = useRecorder(stream, { maxDurationMs: 1000, onComplete: complete });
    r.start(); instances[0].requestData(); instances[0].onerror?.();
    expect(harness.updates).toContain("record_failed"); expect(complete).not.toHaveBeenCalled();
  });
  it("a second start cannot create a parallel recorder", () => {
    const r = useRecorder(stream, { maxDurationMs: 1000, onComplete: vi.fn() }); r.start(); r.start(); expect(instances).toHaveLength(1);
  });
});
