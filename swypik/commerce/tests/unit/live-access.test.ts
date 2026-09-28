import { describe, it, expect } from "vitest";
import { decideLiveAccess, decideTransition } from "@/lib/live/access";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const live = { status: "live" as const, creator_id: CREATOR, sfu_session_id: "sess-host-1" };

describe("decideLiveAccess", () => {
  it("host publish: only the creator (or an admin) of a non-ended stream", () => {
    expect(decideLiveAccess("host", live, null)).toMatchObject({ ok: false, status: 401 });
    expect(decideLiveAccess("host", live, { userId: OTHER, role: "creator" })).toMatchObject({ ok: false, status: 403 });
    expect(decideLiveAccess("host", live, { userId: CREATOR, role: "creator" })).toEqual({ ok: true });
    expect(decideLiveAccess("host", live, { userId: OTHER, role: "admin" })).toEqual({ ok: true });
    expect(decideLiveAccess("host", { ...live, status: "ended" }, { userId: CREATOR, role: null })).toMatchObject({
      ok: false,
      status: 409,
      error: "stream_ended",
    });
    expect(decideLiveAccess("host", { ...live, status: "scheduled", sfu_session_id: null }, { userId: CREATOR, role: null })).toEqual({ ok: true });
  });

  it("viewer pull: anyone (guests too), but only while live with a host session", () => {
    expect(decideLiveAccess("viewer", live, null)).toEqual({ ok: true });
    expect(decideLiveAccess("viewer", { ...live, status: "scheduled" }, null)).toMatchObject({ ok: false, error: "stream_not_live" });
    expect(decideLiveAccess("viewer", { ...live, status: "ended" }, null)).toMatchObject({ ok: false, status: 409 });
    expect(decideLiveAccess("viewer", { ...live, sfu_session_id: null }, null)).toMatchObject({ ok: false, error: "stream_not_live" });
  });
});

describe("decideTransition (heartbeat state machine)", () => {
  it("scheduled → live only with a live host heartbeat AND active media in the SFU", () => {
    expect(decideTransition({ status: "scheduled", hostAlive: true, mediaActive: true })).toBe("go_live");
    expect(decideTransition({ status: "scheduled", hostAlive: true, mediaActive: false })).toBe("wait");
    expect(decideTransition({ status: "scheduled", hostAlive: true, mediaActive: null })).toBe("wait");
    expect(decideTransition({ status: "scheduled", hostAlive: false, mediaActive: true })).toBe("wait");
  });

  it("live stays live while the host beats and ends when the heartbeat expires", () => {
    expect(decideTransition({ status: "live", hostAlive: true, mediaActive: null })).toBe("stay_live");
    expect(decideTransition({ status: "live", hostAlive: false, mediaActive: null })).toBe("end");
  });

  it("ended/failed streams never transition again", () => {
    expect(decideTransition({ status: "ended", hostAlive: true, mediaActive: true })).toBe("none");
    expect(decideTransition({ status: "failed", hostAlive: true, mediaActive: true })).toBe("none");
  });
});
