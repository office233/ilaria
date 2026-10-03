import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));

import { RealtimeUnavailableError } from "@/lib/realtime/config";
import { RealtimeApiError } from "@/lib/realtime/http";
import { addParticipant, createMeeting } from "@/lib/realtime/rtk";
import { createSfuSession, hasActiveLocalTrack, publishTracks } from "@/lib/realtime/sfu";
import { getIceServers } from "@/lib/realtime/turn";

const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

const ENV = {
  CF_REALTIME_APP_ID: "sfu-app",
  CF_REALTIME_APP_TOKEN: "sfu-secret",
  CF_REALTIMEKIT_ACCOUNT_ID: "acct-1",
  CF_REALTIMEKIT_APP_ID: "rtk-app",
  CF_REALTIMEKIT_API_TOKEN: "rtk-token",
};

beforeEach(() => {
  Object.assign(process.env, ENV);
  delete process.env.CF_TURN_KEY_ID;
  delete process.env.CF_TURN_KEY_API_TOKEN;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("SFU client", () => {
  it("throws RealtimeUnavailableError without the app id/secret", async () => {
    delete process.env.CF_REALTIME_APP_TOKEN;
    await expect(createSfuSession()).rejects.toBeInstanceOf(RealtimeUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates sessions with the app secret as Bearer on the app URL", async () => {
    fetchMock.mockReturnValue(reply(201, { sessionId: "s-1" }));
    expect(await createSfuSession()).toBe("s-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/apps/sfu-app/sessions/new");
    expect(init.headers.Authorization).toBe("Bearer sfu-secret");
  });

  it("surfaces per-track errors even on HTTP 200", async () => {
    fetchMock.mockReturnValue(reply(200, { tracks: [{ trackName: "video", errorCode: "invalid_mid", errorDescription: "bad mid" }] }));
    await expect(publishTracks("s-1", { type: "offer", sdp: "x" }, [{ location: "local", mid: "9", trackName: "video" }])).rejects.toMatchObject({
      code: "invalid_mid",
    });
  });

  it("hasActiveLocalTrack only counts active local tracks", () => {
    expect(hasActiveLocalTrack({ tracks: [{ location: "local", status: "inactive" }] })).toBe(false);
    expect(hasActiveLocalTrack({ tracks: [{ location: "remote", status: "active" }] })).toBe(false);
    expect(hasActiveLocalTrack({ tracks: [{ location: "local", status: "active" }] })).toBe(true);
  });
});

describe("TURN", () => {
  it("falls back to Cloudflare STUN without a TURN key", async () => {
    expect(await getIceServers()).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("generates short-lived credentials and drops the browser-blocked port 53", async () => {
    process.env.CF_TURN_KEY_ID = "turn-key";
    process.env.CF_TURN_KEY_API_TOKEN = "turn-token";
    fetchMock.mockReturnValue(
      reply(201, { iceServers: [{ urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp"], username: "u", credential: "c" }] }),
    );
    const servers = await getIceServers();
    expect(servers).toEqual([{ urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "c" }]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/turn-key/credentials/generate-ice-servers");
  });
});

describe("RealtimeKit client", () => {
  it("creates a meeting and adds a participant with the media preset and our user id", async () => {
    fetchMock.mockReturnValueOnce(reply(201, { success: true, data: { id: "m-1" } }));
    fetchMock.mockReturnValueOnce(reply(201, { success: true, data: { id: "p-1", token: "jwt" } }));
    expect(await createMeeting("swypik_call_1")).toBe("m-1");
    const out = await addParticipant("m-1", { userId: "u-1", name: "Ana", media: "audio" });
    expect(out).toEqual({ participantId: "p-1", authToken: "jwt" });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/realtime/kit/rtk-app/meetings/m-1/participants");
    expect(JSON.parse(init.body)).toEqual({ name: "Ana", preset_name: "swypik_call_audio", custom_participant_id: "u-1" });
    expect(init.headers.Authorization).toBe("Bearer rtk-token");
  });

  it("maps Cloudflare API errors to RealtimeApiError", async () => {
    fetchMock.mockReturnValue(reply(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }));
    const err = await createMeeting("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RealtimeApiError);
    expect(err).toMatchObject({ status: 403, code: "10000" });
  });
});
