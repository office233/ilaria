import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForMusicAccess } from "@/components/music/waitForMusicAccess";

describe("music access confirmation after payment", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([401, 403, 404, 429, 500, 503])("does not mistake HTTP %i for granted music access", async (status) => {
    fetchMock.mockResolvedValueOnce({ status, ok: false }).mockResolvedValue({ status: 200, ok: true });
    const result = waitForMusicAccess("song");
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(result).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the paywall when the payment webhook never grants access", async () => {
    fetchMock.mockResolvedValue({ status: 402, ok: false });
    const result = waitForMusicAccess("song");
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("does not poll an abandoned track", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForMusicAccess("song", controller.signal)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
