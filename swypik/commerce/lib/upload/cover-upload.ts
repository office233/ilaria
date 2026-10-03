/** Serialize cover changes per video; failed attempts remain explicitly retryable. */
export function createCoverUploader(upload: (id: string, blob: Blob) => Promise<unknown>) {
  const videos = new Map<string, { sent: Blob | null; tail: Promise<unknown>; pending: Map<Blob, Promise<void>> }>();
  return (id: string, blob: Blob): Promise<void> => {
    let entry = videos.get(id);
    if (!entry) {
      entry = { sent: null, tail: Promise.resolve(), pending: new Map() };
      videos.set(id, entry);
    }
    const existing = entry.pending.get(blob);
    if (existing) return existing;
    const state = entry;
    const task = state.tail.catch(() => undefined).then(async () => {
      if (state.sent === blob) return;
      await upload(id, blob);
      state.sent = blob;
    });
    state.pending.set(blob, task);
    state.tail = task;
    const cleanup = () => { if (state.pending.get(blob) === task) state.pending.delete(blob); };
    void task.then(cleanup, cleanup);
    return task;
  };
}
