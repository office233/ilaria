import { UploadApiError, uploadApi, videoApi, type UploadStatus } from "@/lib/upload/api";
import { activeUploads } from "@/lib/upload/draft-store";
import { uploadMultipart, xhrPutPart } from "@/lib/upload/multipart-client";
import { canonicalVideoType } from "@/lib/video/limits";
export type Trim = { startMs: number | null; endMs: number | null };
export type UploadState =
  | { kind: "idle" | "starting" | "uploaded" | "completing" | "processing" | "ready" | "cancelled" }
  | { kind: "uploading"; loaded: number; total: number }
  | { kind: "failed"; stage: "upload" | "processing"; code: string; retryable: boolean };
type Session = { sessionId: string; videoId: string; partSize: number; totalParts: number };
type Snapshot = { state: UploadState; session: Session | null; trimConfirmed: boolean; pollKey: number };
type RetryAction = "create" | "resume" | "parts" | "complete" | "processing" | "attach";
function errorCode(err: unknown): string {
  if (err instanceof UploadApiError) return err.code;
  if ((err as { name?: string })?.name === "PartUploadError") return "part_failed";
  return "upload_failed";
}
/** Each operation owns its callbacks; replacing it invalidates late results. */
export function createUploadController() {
  let snapshot: Snapshot = { state: { kind: "idle" }, session: null, trimConfirmed: false, pollKey: 0 };
  let current: AbortController | null = null;
  let file: Blob | null = null;
  let creation: { source: "gallery" | "camera"; name: string } | null = null;
  let trim: Trim = { startMs: null, endMs: null };
  let retryAction: RetryAction = "create";
  let completing: AbortController | null = null;
  const listeners = new Set<() => void>();
  const remembered = new Map<string, Promise<void>>();
  const publish = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const active = (op: AbortController) => current === op && !op.signal.aborted;
  const begin = () => {
    current?.abort();
    current = new AbortController();
    completing = null;
    publish({ pollKey: snapshot.pollKey + 1 });
    return current;
  };
  const forget = async (id: string) => {
    await remembered.get(id)?.catch(() => undefined);
    await activeUploads.forget(id).catch(() => undefined);
    remembered.delete(id);
  };
  const abandon = async (id: string) => {
    await uploadApi.abort(id).catch(() => undefined);
    await forget(id);
  };
  const fail = (op: AbortController, err: unknown, stage: "upload" | "processing", action: RetryAction) => {
    if (!active(op)) return;
    retryAction = action;
    const code = errorCode(err);
    publish({ state: { kind: "failed", stage, code, retryable: !["session_closed", "session_expired", "not_found"].includes(code) } });
  };
  const wait = (op: AbortController) => new Promise<void>((resolve) => {
    if (!active(op)) return resolve();
    const done = () => { clearTimeout(timer); op.signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, 5000);
    op.signal.addEventListener("abort", done, { once: true });
  });
  const complete = async (s: Session, op: AbortController) => {
    if (!active(op) || completing === op) return;
    completing = op;
    const confirmedTrim = { ...trim };
    publish({ state: { kind: "completing" } });
    for (let attempt = 1; active(op); attempt++) {
      try {
        const res = await uploadApi.complete(s.sessionId, confirmedTrim);
        if (!active(op)) return;
        void forget(s.sessionId);
        publish({ state: { kind: res.status === "ready" ? "ready" : "processing" } });
        return;
      } catch (err) {
        if (!active(op)) return;
        if (errorCode(err) === "queue_unavailable" && attempt < 6) { await wait(op); continue; }
        fail(op, err, "upload", "complete");
        return;
      }
    }
  };
  const runParts = async (s: Session, blob: Blob, op: AbortController) => {
    if (!active(op)) return;
    publish({ state: { kind: "uploading", loaded: 0, total: blob.size } });
    let uploading = true;
    try {
      await uploadMultipart({
        file: blob, partSize: s.partSize, totalParts: s.totalParts, signal: op.signal,
        onProgress: (loaded, total) => { if (uploading && active(op)) publish({ state: { kind: "uploading", loaded, total } }); },
      }, {
        signParts: (numbers) => uploadApi.signParts(s.sessionId, numbers),
        listParts: () => uploadApi.listParts(s.sessionId).then((r) => r.uploaded), putPart: xhrPutPart,
      });
      uploading = false;
      if (!active(op)) return;
      publish({ state: { kind: "uploaded" } });
      if (snapshot.trimConfirmed) void complete(s, op);
    } catch (err) { uploading = false; fail(op, err, "upload", "parts"); }
  };
  const reset = (retainedSessionId?: string) => {
    const previous = snapshot.session;
    const oldState = snapshot.state.kind;
    const op = begin();
    if (previous && previous.sessionId !== retainedSessionId && ["starting", "uploading", "uploaded", "completing"].includes(oldState)) void abandon(previous.sessionId);
    trim = { startMs: null, endMs: null };
    publish({ session: null, trimConfirmed: false, state: { kind: "starting" } });
    return op;
  };
  const start = async (blob: Blob, source: "gallery" | "camera", name: string) => {
    const op = reset();
    file = blob; creation = { source, name };
    try {
      const s = await uploadApi.createSession({ filename: name, contentType: canonicalVideoType(blob.type, name), sizeBytes: blob.size, source });
      if (!active(op)) { void abandon(s.sessionId); return null; }
      publish({ session: s });
      remembered.set(s.sessionId, activeUploads.remember({ sessionId: s.sessionId, videoId: s.videoId, name, size: blob.size, savedAt: Date.now() }, blob).catch(() => undefined));
      await runParts(s, blob, op);
      return active(op) ? s : null;
    } catch (err) { fail(op, err, "upload", "create"); return null; }
  };
  const resume = async (sessionId: string, videoId: string, blob: Blob) => {
    const op = reset(sessionId);
    file = blob; creation = null;
    publish({ session: { sessionId, videoId, partSize: 0, totalParts: 0 } });
    try {
      const parts = await uploadApi.listParts(sessionId);
      if (!active(op)) return null;
      const s = { sessionId, videoId, partSize: parts.partSize, totalParts: parts.totalParts };
      publish({ session: s });
      await runParts(s, blob, op);
      return active(op) ? s : null;
    } catch (err) { fail(op, err, "upload", "resume"); return null; }
  };
  const attach = async (sessionId: string, videoId: string) => {
    const op = reset(sessionId);
    file = null; creation = null;
    publish({ session: { sessionId, videoId, partSize: 0, totalParts: 0 }, trimConfirmed: true });
    try {
      const status = await uploadApi.status(sessionId);
      if (!active(op)) return;
      if (status.phase === "ready") publish({ state: { kind: "ready" } });
      else if (status.phase === "failed") {
        retryAction = "processing";
        publish({ state: { kind: "failed", stage: "processing", code: status.errorCode ?? "internal_error", retryable: status.canRetry } });
      } else if (status.phase === "aborted") publish({ state: { kind: "cancelled" } });
      else if (status.phase === "uploading") publish({ state: { kind: "failed", stage: "upload", code: "upload_incomplete", retryable: false } });
      else publish({ state: { kind: "processing" } });
    } catch (err) { fail(op, err, "processing", "attach"); }
  };
  const cancel = async () => {
    const s = snapshot.session;
    current?.abort(); current = null; completing = null;
    file = null; creation = null;
    publish({ state: { kind: "cancelled" }, session: null, trimConfirmed: false });
    if (s) await abandon(s.sessionId);
  };
  const retry = async () => {
    if (snapshot.state.kind !== "failed" || !snapshot.state.retryable) return;
    const s = snapshot.session;
    if (retryAction === "create" && file && creation) {
      const pendingTrim = trim, confirmed = snapshot.trimConfirmed;
      const pending = start(file, creation.source, creation.name);
      trim = pendingTrim;
      publish({ trimConfirmed: confirmed });
      await pending; return;
    }
    if (!s) return;
    if (retryAction === "resume" && file) {
      const pendingTrim = trim, confirmed = snapshot.trimConfirmed;
      const pending = resume(s.sessionId, s.videoId, file);
      trim = pendingTrim;
      publish({ trimConfirmed: confirmed });
      await pending; return;
    }
    if (retryAction === "attach") { await attach(s.sessionId, s.videoId); return; }
    const op = begin();
    if (retryAction === "processing") {
      publish({ state: { kind: "completing" } });
      try {
        await videoApi.reprocess(s.videoId);
        if (active(op)) publish({ state: { kind: "processing" } });
      } catch (err) { fail(op, err, "processing", "processing"); }
    } else if (retryAction === "complete") await complete(s, op);
    else if (file) await runParts(s, file, op);
  };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot, start, resume, attach, cancel, retry,
    confirmTrim: (value: Trim) => {
      trim = value; publish({ trimConfirmed: true });
      if (snapshot.state.kind === "uploaded" && snapshot.session && current) void complete(snapshot.session, current);
    },
    processingStatus: (status: UploadStatus) => {
      if (snapshot.state.kind !== "processing") return;
      if (status.phase === "ready") publish({ state: { kind: "ready" } });
      else if (status.phase === "aborted") publish({ state: { kind: "cancelled" } });
      else if (status.phase === "failed") {
        retryAction = "processing";
        publish({ state: { kind: "failed", stage: "processing", code: status.errorCode ?? "internal_error", retryable: status.canRetry } });
      }
    },
    // Keep established remote/local drafts recoverable on unmount.
    dispose: () => { current?.abort(); current = null; },
  };
}
