import { describe, it, expect, vi, beforeEach } from "vitest";

const jar = new Map<string, string>();
let cookieWritable = true;
const setCalls: string[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      if (!cookieWritable) throw new Error("Cookies can only be modified in a Server Action or Route Handler");
      setCalls.push(name);
      jar.set(name, value);
    },
  }),
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9" }),
}));

let mintOk = true;
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: mintOk, remaining: 1 }),
  getClientIPFromHeaders: (h: Headers) => h.get("x-real-ip") ?? "unknown",
}));

const inserts: unknown[][] = [];
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("INSERT INTO users")) {
      inserts.push(params);
      return { rows: [{ id: params[0] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

import {
  AnonSessionError,
  anonSessionErrorResponse,
  getAccountUserId,
  getOrCreateSocialUser,
  getSocialIdentity,
  signAnonValue,
} from "@/lib/social/session";

beforeEach(() => {
  jar.clear();
  setCalls.length = 0;
  inserts.length = 0;
  cookieWritable = true;
  mintOk = true;
});

describe("getOrCreateSocialUser (cookie-bound anon identities)", () => {
  it("binds the new anon identity to a cookie before creating the users row", async () => {
    const s = await getOrCreateSocialUser();
    expect(s.isAnon).toBe(true);
    expect(setCalls).toEqual(["anon_session"]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toBe(s.userId);
  });

  it("creates no users row when the cookie cannot be written (e.g. RSC render)", async () => {
    cookieWritable = false;
    await expect(getOrCreateSocialUser()).rejects.toMatchObject({ status: 403 });
    expect(inserts).toHaveLength(0);
  });

  it("refuses to mint when the per-IP limit is exhausted", async () => {
    mintOk = false;
    const err = await getOrCreateSocialUser().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnonSessionError);
    expect(inserts).toHaveLength(0);
    const res = anonSessionErrorResponse(err);
    expect(res?.status).toBe(429);
  });

  it("reuses an existing signed anon cookie and reports it as anonymous", async () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    jar.set("anon_session", signAnonValue(id));
    const s = await getOrCreateSocialUser();
    expect(s).toMatchObject({ userId: id, isAnon: true });
    expect(setCalls).toHaveLength(0);
    expect(await getSocialIdentity()).toMatchObject({ userId: id, isAnon: true });
    expect(await getAccountUserId()).toBeNull();
  });

  it("maps unrelated errors to null", () => {
    expect(anonSessionErrorResponse(new Error("x"))).toBeNull();
  });
});
