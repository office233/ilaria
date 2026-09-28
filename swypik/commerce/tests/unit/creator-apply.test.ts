import { describe, it, expect, vi, beforeEach } from "vitest";

let role = "shopper";
let openApp: Record<string, unknown> | null = null;
let handleTaken = false;
let insertError: { code: string } | null = null;
let sessionUser: string | null = "u1";
const inserts: unknown[][] = [];

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("SELECT role FROM users")) return { rows: [{ role }], rowCount: 1 };
    if (sql.includes("FROM creator_applications")) return { rows: openApp ? [openApp] : [], rowCount: openApp ? 1 : 0 };
    if (sql.includes("lower(username)")) return { rows: handleTaken ? [{ one: 1 }] : [], rowCount: handleTaken ? 1 : 0 };
    if (sql.startsWith("INSERT INTO creator_applications")) {
      if (insertError) throw insertError;
      inserts.push(params);
      return {
        rows: [{ id: "app1", status: "submitted", requested_handle: params[1], category: params[2], review_note: null, created_at: "2026-09-25", reviewed_at: null }],
        rowCount: 1,
      };
    }
    throw new Error("unexpected " + sql.slice(0, 60));
  }),
}));
vi.mock("@/lib/creator/session", () => ({ getCreatorUserId: async () => sessionUser }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));

import { creatorApplySchema, submitApplication, getApplicationState } from "@/lib/creator/application";
import { GET, POST } from "@/app/api/creator/apply/route";

const valid = { handle: "ana.reviews", category: "beauty", links: ["https://instagram.com/ana"] };

beforeEach(() => {
  role = "shopper";
  openApp = null;
  handleTaken = false;
  insertError = null;
  sessionUser = "u1";
  inserts.length = 0;
});

describe("creatorApplySchema", () => {
  it("acceptă formularul valid și respinge handle/linkuri invalide", () => {
    expect(creatorApplySchema.safeParse(valid).success).toBe(true);
    expect(creatorApplySchema.safeParse({ ...valid, handle: "a b" }).success).toBe(false);
    expect(creatorApplySchema.safeParse({ ...valid, category: "crypto" }).success).toBe(false);
    expect(creatorApplySchema.safeParse({ ...valid, links: ["http://nesigur.ro"] }).success).toBe(false);
    expect(creatorApplySchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});

describe("apply flow — fără bucla „ești creator” → /upload → înapoi", () => {
  it("shopper nou → aplicare 'pending' (rolul NU se schimbă)", async () => {
    const r = await submitApplication("u1", creatorApplySchema.parse(valid));
    expect(r).toMatchObject({ ok: true, created: true, state: { state: "pending", application: { handle: "ana.reviews" } } });
    expect(inserts).toHaveLength(1);
  });
  it("aplicare deja deschisă → o întoarce, fără rând nou", async () => {
    openApp = { id: "app0", status: "submitted", requested_handle: "ana", category: "beauty", review_note: null, created_at: "x", reviewed_at: null };
    const r = await submitApplication("u1", creatorApplySchema.parse(valid));
    expect(r).toMatchObject({ ok: true, created: false, state: { state: "pending" } });
    expect(inserts).toHaveLength(0);
  });
  it("după respingere se poate aplica din nou; starea arată motivul", async () => {
    openApp = { id: "app0", status: "rejected", requested_handle: "ana", category: null, review_note: "fără clipuri", created_at: "x", reviewed_at: "y" };
    expect(await getApplicationState("u1")).toMatchObject({ state: "rejected", application: { reviewNote: "fără clipuri" } });
    expect((await submitApplication("u1", creatorApplySchema.parse(valid))).ok).toBe(true);
  });
  it("creator / seller / handle ocupat", async () => {
    role = "creator";
    expect(await submitApplication("u1", creatorApplySchema.parse(valid))).toEqual({ ok: false, code: "already_creator" });
    role = "seller";
    expect(await submitApplication("u1", creatorApplySchema.parse(valid))).toEqual({ ok: false, code: "seller_cannot_apply" });
    role = "shopper";
    handleTaken = true;
    expect(await submitApplication("u1", creatorApplySchema.parse(valid))).toEqual({ ok: false, code: "handle_taken" });
  });
  it("cursă pe indexul unic (dublu click) → întoarce aplicarea existentă", async () => {
    insertError = { code: "23505" };
    const r = await submitApplication("u1", creatorApplySchema.parse(valid));
    expect(r).toMatchObject({ ok: true, created: false });
  });
});

describe("/api/creator/apply", () => {
  it("GET fără sesiune → guest; POST fără sesiune → 401", async () => {
    sessionUser = null;
    expect(await (await GET()).json()).toEqual({ state: "guest" });
    const res = await POST(new Request("http://x/api/creator/apply", { method: "POST", body: JSON.stringify(valid) }));
    expect(res.status).toBe(401);
  });
  it("POST invalid → 400 cu câmpul vinovat; valid → 201 pending", async () => {
    const bad = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ ...valid, handle: "!" }) }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).field).toBe("handle");
    const ok = await POST(new Request("http://x", { method: "POST", body: JSON.stringify(valid) }));
    expect(ok.status).toBe(201);
    expect((await ok.json()).state).toBe("pending");
  });
  it("seller → 403 seller_cannot_apply", async () => {
    role = "seller";
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify(valid) }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("seller_cannot_apply");
  });
});
