import { describe, expect, it, vi } from "vitest";
import { createCoverUploader } from "@/lib/upload/cover-upload";

describe("cover upload coordination", () => {
  it("retries a failed cover rather than treating it as uploaded", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const upload = createCoverUploader(send);
    const blob = new Blob(["cover"]);
    await expect(upload("a", blob)).rejects.toThrow("offline");
    await upload("a", blob);
    await upload("a", blob);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("deduplicates an effect and a submit waiting for the same cover", async () => {
    let finish!: () => void;
    const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const upload = createCoverUploader(send);
    const blob = new Blob(["cover"]);
    const first = upload("a", blob);
    const second = upload("a", blob);
    expect(second).toBe(first);
    await Promise.resolve(); await Promise.resolve();
    finish(); await first;
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not skip the same Blob on a different video", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const upload = createCoverUploader(send);
    const blob = new Blob(["cover"]);
    await upload("a", blob); await upload("b", blob);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("serializes replacement covers so an older request cannot overwrite the new cover", async () => {
    let finish!: () => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const upload = createCoverUploader(send);
    const a = new Blob(["a"]); const b = new Blob(["b"]);
    const first = upload("video", a); const second = upload("video", b);
    await Promise.resolve(); await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    finish(); await first; await second;
    expect(send.mock.calls.map(call => call[1])).toEqual([a, b]);
    await upload("video", a);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
