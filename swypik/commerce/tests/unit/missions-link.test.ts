import { describe, it, expect, vi, beforeEach } from "vitest";

type Handler = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number };
let handler: Handler = () => ({ rows: [], rowCount: 0 });
const seen: string[] = [];

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    seen.push(sql);
    return handler(sql, params);
  }),
}));

import { linkVideoToMission, linkErrorStatus } from "@/lib/missions/submissions";
import { applyVideoMissionField } from "@/lib/missions/video-field";
import { getMissionBadges } from "@/lib/missions/feed-badge";
import { GET as listMissions } from "@/app/api/missions/route";

const M = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";

function world(opts: { mission?: boolean; owner?: string | null; video?: boolean; existing?: { id: string; mission_id: string } | null; insert?: boolean }) {
  handler = (sql) => {
    if (sql.includes("FROM creator_missions m") && sql.includes("LEFT JOIN sellers")) {
      return opts.mission === false ? { rows: [], rowCount: 0 } : { rows: [{ id: M, owner_user_id: opts.owner ?? null }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id FROM videos")) return opts.video === false ? { rows: [], rowCount: 0 } : { rows: [{ id: V }], rowCount: 1 };
    if (sql.startsWith("SELECT id, mission_id FROM creator_mission_submissions")) {
      return opts.existing ? { rows: [opts.existing], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO creator_mission_submissions")) {
      return opts.insert === false ? { rows: [], rowCount: 0 } : { rows: [{ id: "sub-new" }], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM creator_mission_submissions")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
}

beforeEach(() => {
  seen.length = 0;
});

describe("linkVideoToMission (înscriere clip)", () => {
  it("înscrie un clip propriu la o misiune deschisă și finanțată", async () => {
    world({});
    expect(await linkVideoToMission({ userId: "u1", videoId: V, missionId: M })).toEqual({ ok: true, submissionId: "sub-new", alreadyLinked: false });
    expect(seen[0]).toContain("m.funding_status = 'funded'");
  });
  it("misiune închisă / nefinanțată → mission_not_open (404)", async () => {
    world({ mission: false });
    const r = await linkVideoToMission({ userId: "u1", videoId: V, missionId: M });
    expect(r).toEqual({ ok: false, code: "mission_not_open" });
    expect(linkErrorStatus("mission_not_open")).toBe(404);
  });
  it("sellerul nu se poate înscrie la propria misiune", async () => {
    world({ owner: "u1" });
    expect(await linkVideoToMission({ userId: "u1", videoId: V, missionId: M })).toEqual({ ok: false, code: "own_mission" });
  });
  it("clipul altcuiva sau șters → video_not_eligible (403)", async () => {
    world({ video: false });
    expect(await linkVideoToMission({ userId: "u1", videoId: V, missionId: M })).toEqual({ ok: false, code: "video_not_eligible" });
  });
  it("același clip la aceeași misiune e idempotent; la altă misiune → 409", async () => {
    world({ existing: { id: "sub-old", mission_id: M } });
    expect(await linkVideoToMission({ userId: "u1", videoId: V, missionId: M })).toEqual({ ok: true, submissionId: "sub-old", alreadyLinked: true });
    world({ existing: { id: "sub-old", mission_id: "altceva" } });
    expect(await linkVideoToMission({ userId: "u1", videoId: V, missionId: M })).toEqual({ ok: false, code: "video_in_other_mission" });
    expect(linkErrorStatus("video_in_other_mission")).toBe(409);
  });
});

describe("applyVideoMissionField (câmpul missionId din PATCH /api/creator/videos/[id])", () => {
  it("respinge id-uri invalide", async () => {
    expect(await applyVideoMissionField({ userId: "u1", videoId: V, missionId: "nu-e-uuid" })).toEqual({ ok: false, code: "invalid_mission_id", status: 400 });
    expect(await applyVideoMissionField({ userId: "u1", videoId: V, missionId: 42 })).toMatchObject({ ok: false, status: 400 });
  });
  it("null retrage clipul (doar înscrieri nejurizate)", async () => {
    world({});
    const r = await applyVideoMissionField({ userId: "u1", videoId: V, missionId: null });
    expect(r).toEqual({ ok: true, value: { missionId: null, submissionId: null } });
    expect(seen.find((s) => s.startsWith("DELETE"))).toContain("status IN ('submitted', 'approved')");
  });
  it("uuid valid → înscriere + status HTTP mapat pe eroare", async () => {
    world({});
    expect(await applyVideoMissionField({ userId: "u1", videoId: V, missionId: M })).toEqual({ ok: true, value: { missionId: M, submissionId: "sub-new" } });
    world({ mission: false });
    expect(await applyVideoMissionField({ userId: "u1", videoId: V, missionId: M })).toEqual({ ok: false, code: "mission_not_open", status: 404 });
  });
});

describe("getMissionBadges (feed)", () => {
  it("mapează clip → misiune, fără query pentru liste goale/invalide", async () => {
    handler = () => ({
      rows: [{ video_id: V, mission_id: M, slug: "unboxing", title: "Unboxing", prize_amount_minor: 5000, open: true, winner: false }],
      rowCount: 1,
    });
    expect((await getMissionBadges(["x", ""])).size).toBe(0);
    expect(seen).toHaveLength(0);
    const map = await getMissionBadges([V, V]);
    expect(map.get(V)).toEqual({ missionId: M, slug: "unboxing", title: "Unboxing", prizeCents: 5000, currency: "RON", open: true, winner: false });
  });
  it("o eroare DB nu strică feed-ul (map gol)", async () => {
    handler = () => {
      throw new Error("db down");
    };
    expect((await getMissionBadges([V])).size).toBe(0);
  });
});

describe("GET /api/missions", () => {
  it("listează doar misiuni RON finanțate și deschise", async () => {
    handler = () => ({ rows: [], rowCount: 0 });
    const res = await listMissions(new Request("http://localhost/api/missions?limit=500"));
    expect(res.status).toBe(200);
    expect((await res.json()).missions).toEqual([]);
    expect(seen[0]).toContain("m.funding_status = 'funded'");
    expect(seen[0]).toContain("m.prize_currency = 'RON'");
  });
});
