import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), complete: vi.fn(), abort: vi.fn(), status: vi.fn(), reprocess: vi.fn(), multipart: vi.fn(), remember: vi.fn(), forget: vi.fn() }));
vi.mock("@/lib/upload/api", () => ({
  UploadApiError: class extends Error { constructor(public code: string) { super(code); } },
  uploadApi: { createSession: m.create, listParts: m.list, signParts: vi.fn(), complete: m.complete, abort: m.abort, status: m.status },
  videoApi: { reprocess: m.reprocess },
}));
vi.mock("@/lib/upload/multipart-client", () => ({ uploadMultipart: m.multipart, xhrPutPart: vi.fn() }));
vi.mock("@/lib/upload/draft-store", () => ({ activeUploads: { remember: m.remember, forget: m.forget } }));
import { UploadApiError } from "@/lib/upload/api";
import { createUploadController } from "@/components/upload/upload-controller";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const session = (id = "one") => ({ sessionId: id, videoId: `v-${id}`, partSize: 8, totalParts: 1, expiresAt: "later" });
const blob = new Blob(["video"], { type: "video/mp4" });
const trim = { startMs: 100, endMs: 500 };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.resetAllMocks();
  m.create.mockResolvedValue(session()); m.list.mockResolvedValue({ partSize: 8, totalParts: 1, uploaded: [] });
  m.multipart.mockResolvedValue(undefined); m.remember.mockResolvedValue(undefined); m.forget.mockResolvedValue(undefined);
  m.abort.mockResolvedValue({ aborted: true }); m.complete.mockResolvedValue({ status: "processing" });
  m.reprocess.mockResolvedValue({ jobId: "job" });
});
afterEach(() => vi.useRealTimers());
describe("Upload lifecycle", () => {
  it("cancel during session creation rejects late session and never uploads", async () => {
    const late = deferred<ReturnType<typeof session>>(); m.create.mockReturnValue(late.promise);
    const c = createUploadController(); const started = c.start(blob, "camera", "camera.mp4");
    await c.cancel(); late.resolve(session()); expect(await started).toBeNull(); await flush();
    expect(c.getSnapshot().state.kind).toBe("cancelled"); expect(m.multipart).not.toHaveBeenCalled();
    expect(m.abort).toHaveBeenCalledWith("one"); expect(m.remember).not.toHaveBeenCalled();
  });
  it("superseded create and errors cannot overwrite a new session", async () => {
    const late = deferred<ReturnType<typeof session>>(); m.create.mockReturnValueOnce(late.promise).mockResolvedValueOnce(session("two"));
    const c = createUploadController(); const first = c.start(blob, "gallery", "one.mp4");
    await c.start(blob, "gallery", "two.mp4"); late.resolve(session("one")); await first;
    expect(c.getSnapshot().session?.sessionId).toBe("two"); expect(c.getSnapshot().state.kind).toBe("uploaded");
    expect(m.multipart).toHaveBeenCalledTimes(1); expect(m.abort).toHaveBeenCalledWith("one");
  });
  it("cancel immediately wins over stale multipart progress, success, and abort request", async () => {
    const parts = deferred<void>(), abort = deferred<{ aborted: boolean }>(); m.multipart.mockReturnValue(parts.promise); m.abort.mockReturnValue(abort.promise);
    const c = createUploadController(); const started = c.start(blob, "gallery", "one.mp4"); await flush();
    const progress = m.multipart.mock.calls[0][0].onProgress; const cancelled = c.cancel();
    expect(c.getSnapshot().state.kind).toBe("cancelled"); progress(5, 5); parts.resolve(); await started;
    expect(c.getSnapshot().state.kind).toBe("cancelled"); abort.resolve({ aborted: true }); await cancelled;
  });
  it("retry after create failure recreates session with file metadata and confirmed trim", async () => {
    const create = deferred<ReturnType<typeof session>>(); m.create.mockReturnValueOnce(create.promise).mockResolvedValueOnce(session());
    const c = createUploadController(); const started = c.start(blob, "camera", "camera.mp4"); c.confirmTrim(trim);
    create.reject(new Error("network")); await started;
    expect(c.getSnapshot().session).toBeNull(); await c.retry(); await flush();
    expect(m.create).toHaveBeenCalledTimes(2);
    expect(m.create).toHaveBeenLastCalledWith(expect.objectContaining({ filename: "camera.mp4", source: "camera", sizeBytes: blob.size }));
    expect(m.complete).toHaveBeenCalledExactlyOnceWith("one", trim);
  });
  it("trim confirmed during upload completes exactly once despite reentry", async () => {
    const parts = deferred<void>(); m.multipart.mockReturnValue(parts.promise);
    const c = createUploadController(); const pending = c.start(blob, "camera", "video.mp4"); await flush();
    c.confirmTrim(trim); c.confirmTrim(trim); parts.resolve(); await pending; c.confirmTrim(trim); await c.retry();
    expect(m.complete).toHaveBeenCalledTimes(1);
  });
  it("late progress after parts finished cannot rewind completing or ready state", async () => {
    const c = createUploadController(); await c.start(blob, "gallery", "video.mp4");
    const progress = m.multipart.mock.calls[0][0].onProgress;
    c.confirmTrim(trim); progress(1, 5);
    expect(c.getSnapshot().state.kind).toBe("completing");
    await flush(); progress(2, 5);
    expect(c.getSnapshot().state.kind).toBe("processing");
  });
  it("cancel interrupts completion backoff and prevents later complete requests", async () => {
    vi.useFakeTimers(); m.complete.mockRejectedValue(new UploadApiError("queue_unavailable", 503));
    const c = createUploadController(); await c.start(blob, "gallery", "video.mp4"); c.confirmTrim(trim); await flush();
    expect(m.complete).toHaveBeenCalledTimes(1); await c.cancel(); await vi.advanceTimersByTimeAsync(60000);
    expect(m.complete).toHaveBeenCalledTimes(1); expect(c.getSnapshot().state.kind).toBe("cancelled");
  });
  it("completion failure retries completion without reuploading and late success cannot uncancel", async () => {
    m.complete.mockRejectedValueOnce(new Error("network"));
    const c = createUploadController(); await c.start(blob, "gallery", "video.mp4"); c.confirmTrim(trim); await flush();
    const complete = deferred<{ status: string }>(); m.complete.mockReturnValueOnce(complete.promise);
    const retry = c.retry(); await c.cancel(); complete.resolve({ status: "ready" }); await retry;
    expect(m.multipart).toHaveBeenCalledTimes(1); expect(m.complete).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot().state.kind).toBe("cancelled");
  });
  it("resume list failure is retryable and preserves trim", async () => {
    m.list.mockRejectedValueOnce(new Error("network"));
    const c = createUploadController(); await c.resume("one", "v-one", blob); c.confirmTrim(trim); await c.retry(); await flush();
    expect(m.list).toHaveBeenCalledTimes(2); expect(m.complete).toHaveBeenCalledExactlyOnceWith("one", trim);
    expect(m.abort).not.toHaveBeenCalled();
  });
  it("unmount invalidates callbacks but preserves established recovery draft", async () => {
    const parts = deferred<void>(); m.multipart.mockReturnValue(parts.promise);
    const c = createUploadController(); const pending = c.start(blob, "gallery", "video.mp4"); await flush(); c.dispose();
    parts.resolve(); expect(await pending).toBeNull(); expect(m.abort).not.toHaveBeenCalled(); expect(m.forget).not.toHaveBeenCalled();
  });
  it("StrictMode-style dispose and reattach same session does not abort it", async () => {
    const firstStatus = deferred<any>(); m.status.mockReturnValueOnce(firstStatus.promise).mockResolvedValueOnce({ phase: "ready" });
    const c = createUploadController(); const first = c.attach("one", "v-one"); c.dispose(); await c.attach("one", "v-one");
    firstStatus.resolve({ phase: "failed", canRetry: true }); await first;
    expect(c.getSnapshot().state.kind).toBe("ready"); expect(m.abort).not.toHaveBeenCalled();
  });
  it("cancellation waits for in-flight draft remember before deleting its blob", async () => {
    const remember = deferred<void>(); m.remember.mockReturnValue(remember.promise);
    const c = createUploadController(); await c.start(blob, "gallery", "video.mp4"); const cancelled = c.cancel(); await flush();
    expect(m.forget).not.toHaveBeenCalled(); remember.resolve(); await cancelled; expect(m.forget).toHaveBeenCalledWith("one");
  });
  it("processing retry is single-flight and its response cannot overwrite cancellation", async () => {
    m.status.mockResolvedValue({ phase: "failed", errorCode: "worker_failed", canRetry: true });
    const pending = deferred<{ jobId: string }>(); m.reprocess.mockReturnValue(pending.promise);
    const c = createUploadController(); await c.attach("one", "v-one"); const retry = c.retry(); await c.retry(); await c.cancel();
    pending.resolve({ jobId: "job" }); await retry;
    expect(m.reprocess).toHaveBeenCalledTimes(1); expect(c.getSnapshot().state.kind).toBe("cancelled");
  });
});
