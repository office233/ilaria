import { describe, it, expect, vi, beforeEach } from "vitest";

type Q = { sql: string; params: unknown[] };
let calls: Q[] = [];
let subRow: Record<string, unknown> | null = null;
let paidCount = 0;
let related = false;
let notifyThrows = false;
const creditCalls: Array<Record<string, unknown>> = [];
const notices: Array<{ userId: string; notice: string }> = [];

function q(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
  if (sql.includes("FROM creator_mission_submissions s") && sql.includes("FOR UPDATE")) {
    return { rows: subRow ? [subRow] : [], rowCount: subRow ? 1 : 0 };
  }
  if (sql.includes("COUNT(*)::int AS n")) return { rows: [{ n: paidCount }], rowCount: 1 };
  if (sql.includes("AS related")) return { rows: [{ related }], rowCount: 1 };
  return { rows: [], rowCount: 1 };
}

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => q(sql, params)),
  withTransaction: async (fn: (qq: unknown) => Promise<unknown>) => fn(async (sql: string, params: unknown[] = []) => q(sql, params)),
}));
vi.mock("@/lib/wallet/ledger", () => ({
  creditUserTx: vi.fn(async (_q: unknown, args: Record<string, unknown>) => {
    creditCalls.push(args);
    return { entry: { id: "l1" }, alreadyApplied: false };
  }),
}));
vi.mock("@/lib/notifications/localized", () => ({
  notifyLocalized: vi.fn(async (userId: string, notice: string) => {
    if (notifyThrows) throw new Error("push down");
    notices.push({ userId, notice });
  }),
}));

import { judgeSubmission, judgeErrorStatus } from "@/lib/missions/judging";

const baseSub = {
  id: "sub1", status: "submitted", user_id: "creator1", video_id: "v1", video_status: "ready",
  mission_id: "m1", mission_slug: "unboxing", mission_title: "Unboxing", mission_status: "active", seller_id: "seller1",
  funding_status: "funded", prize_amount_minor: 10_000, max_winners: 2,
  funded_cents: "20000", paid_out_cents: "0", refunded_cents: "0",
};

beforeEach(() => {
  calls = [];
  creditCalls.length = 0;
  notices.length = 0;
  subRow = { ...baseSub };
  paidCount = 0;
  related = false;
  notifyThrows = false;
});

describe("judgeSubmission — winner = selectare + plată atomică", () => {
  it("plătește premiul din escrow și creditează portofelul creatorului în aceeași tranzacție", async () => {
    const r = await judgeSubmission("sub1", { action: "winner" }, { kind: "seller", sellerId: "seller1" });
    expect(r).toEqual({ ok: true, status: "paid", prizeCents: 10_000 });
    expect(calls.find((c) => c.sql.includes("paid_out_cents = paid_out_cents + $2"))?.params).toEqual(["m1", 10_000]);
    expect(calls.some((c) => c.sql.includes("SET status = 'paid'"))).toBe(true);
    expect(creditCalls[0]).toMatchObject({
      userId: "creator1",
      amountCents: 10_000,
      refType: "mission_prize",
      refId: "mission:m1:submission:sub1",
    });
    expect(notices).toEqual([{ userId: "creator1", notice: "missionWinner" }]);
  });

  it("escrow insuficient → nicio plată", async () => {
    subRow = { ...baseSub, funded_cents: "20000", paid_out_cents: "15000" };
    const r = await judgeSubmission("sub1", { action: "winner" }, { kind: "admin", label: "a" });
    expect(r).toEqual({ ok: false, code: "escrow_insufficient" });
    expect(creditCalls).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it("locurile de câștigător epuizate → no_winner_slots", async () => {
    paidCount = 2;
    const r = await judgeSubmission("sub1", { action: "winner" }, { kind: "admin", label: "a" });
    expect(r).toEqual({ ok: false, code: "no_winner_slots" });
    expect(creditCalls).toHaveLength(0);
  });

  it("clip nepublicat → video_not_published (422)", async () => {
    subRow = { ...baseSub, video_status: "processing" };
    const r = await judgeSubmission("sub1", { action: "winner" }, { kind: "admin", label: "a" });
    expect(r).toEqual({ ok: false, code: "video_not_published" });
    expect(judgeErrorStatus("video_not_published")).toBe(422);
  });

  it("misiune nefinanțată → mission_not_funded", async () => {
    subRow = { ...baseSub, funding_status: "pending" };
    expect(await judgeSubmission("sub1", { action: "winner" }, { kind: "admin", label: "a" })).toEqual({ ok: false, code: "mission_not_funded" });
  });

  it("un seller nu poate jura misiunea altui seller", async () => {
    const r = await judgeSubmission("sub1", { action: "winner" }, { kind: "seller", sellerId: "intrus" });
    expect(r).toEqual({ ok: false, code: "not_found" });
    expect(judgeErrorStatus("not_found")).toBe(404);
    expect(creditCalls).toHaveLength(0);
  });

  it("înscriere deja plătită nu poate fi plătită din nou", async () => {
    subRow = { ...baseSub, status: "paid" };
    expect(await judgeSubmission("sub1", { action: "winner" }, { kind: "admin", label: "a" })).toEqual({ ok: false, code: "invalid_transition" });
    expect(await judgeSubmission("sub1", { action: "reject" }, { kind: "admin", label: "a" })).toEqual({ ok: false, code: "invalid_transition" });
  });
});

describe("judgeSubmission — reject / pay", () => {
  it("reject salvează motivul și anunță creatorul", async () => {
    const r = await judgeSubmission("sub1", { action: "reject", reason: "off-topic" }, { kind: "seller", sellerId: "seller1" });
    expect(r).toEqual({ ok: true, status: "rejected" });
    const upd = calls.find((c) => c.sql.includes("SET status = 'rejected'"));
    expect(upd?.params).toEqual(["sub1", "off-topic", "seller:seller1"]);
    expect(notices).toEqual([{ userId: "creator1", notice: "missionRejected" }]);
  });
  it("pay reîncearcă doar rânduri vechi winner/approved", async () => {
    subRow = { ...baseSub, status: "submitted" };
    expect(await judgeSubmission("sub1", { action: "pay" }, { kind: "admin", label: "a" })).toEqual({ ok: false, code: "invalid_transition" });
    subRow = { ...baseSub, status: "approved" };
    expect(await judgeSubmission("sub1", { action: "pay" }, { kind: "admin", label: "a" })).toMatchObject({ ok: true, status: "paid" });
  });
});

describe("judgeSubmission — anti-fraudă și mașina de stări", () => {
  it("misiune închisă → mission_closed (nu se mai plătește din escrow-ul returnat)", async () => {
    subRow = { ...baseSub, mission_status: "closed" };
    expect(await judgeSubmission("sub1", { action: "winner" }, { kind: "admin", label: "a" })).toEqual({ ok: false, code: "mission_closed" });
    expect(judgeErrorStatus("mission_closed")).toBe(409);
    expect(creditCalls).toHaveLength(0);
  });

  it("câștigător legat de finanțator (cont, contact, IP/dispozitiv) → self_dealing, fără plată", async () => {
    related = true;
    const r = await judgeSubmission("sub1", { action: "winner" }, { kind: "seller", sellerId: "seller1" });
    expect(r).toEqual({ ok: false, code: "self_dealing" });
    expect(creditCalls).toHaveLength(0);
    const check = calls.find((c) => c.sql.includes("AS related"));
    expect(check?.params.slice(0, 2)).toEqual(["creator1", "m1"]);
    expect(check?.sql).toContain("ip_address");
    expect(check?.sql).toContain("lower(w.email) = lower(s.email)");
  });

  it("verificarea anti-fraudă rulează în tranzacție, după blocarea misiunii", async () => {
    await judgeSubmission("sub1", { action: "winner" }, { kind: "admin", label: "a" });
    const lockIdx = calls.findIndex((c) => c.sql.includes("FOR UPDATE OF m, s"));
    const relIdx = calls.findIndex((c) => c.sql.includes("AS related"));
    const payIdx = calls.findIndex((c) => c.sql.includes("paid_out_cents = paid_out_cents + $2"));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(relIdx).toBeGreaterThan(lockIdx);
    expect(payIdx).toBeGreaterThan(relIdx);
  });

  it("notificarea eșuată după plată nu transformă succesul în eroare", async () => {
    notifyThrows = true;
    expect(await judgeSubmission("sub1", { action: "winner" }, { kind: "admin", label: "a" })).toEqual({ ok: true, status: "paid", prizeCents: 10_000 });
    expect(creditCalls).toHaveLength(1);
  });
});
