import { describe, it, expect, vi, beforeEach } from "vitest";

let accountId: string | null = null;
const { getOrCreate } = vi.hoisted(() => ({ getOrCreate: vi.fn() }));
vi.mock("@/lib/social/session", () => ({
  getAccountUserId: async () => accountId,
  getOptionalSocialUserId: async () => accountId,
  getOrCreateSocialUser: getOrCreate,
  setAnonSessionCookie: () => undefined,
  anonSessionErrorResponse: () => null,
}));

vi.mock("@/lib/feature-flags", () => ({
  isEnabled: () => true,
  frozenResponse: () => new Response(null, { status: 410 }),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 1 }),
  getClientIP: () => "1.1.1.1",
}));

const dbCalls: string[] = [];
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string) => {
    dbCalls.push(sql);
    return { rows: [], rowCount: 0 };
  }),
  getDb: () => ({ connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }) }),
}));

vi.mock("@/lib/dm/repository", () => ({
  getOrCreateDmConversation: vi.fn(async () => ({ conversationId: "c1", isNew: true })),
  listConversations: vi.fn(async () => []),
  listMessages: vi.fn(async () => []),
  sendMessage: vi.fn(async () => ({ id: "m1" })),
  markRead: vi.fn(async () => null),
  isStatusError: () => false,
}));

import { POST as createConversation } from "@/app/api/dm/conversations/route";
import { POST as sendMessage } from "@/app/api/dm/conversations/[id]/messages/route";
import { GET as gamingProfile } from "@/app/api/gaming/profile/route";
import { POST as gamingStart } from "@/app/api/gaming/session/start/route";

const PEER = "0f8fad5b-d9cb-469f-a165-70867728950e";

function post(body: unknown): Request {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  accountId = null;
  getOrCreate.mockReset();
  dbCalls.length = 0;
});

describe("routes that require a real account", () => {
  it("DM create rejects anonymous visitors without minting a user", async () => {
    const res = await createConversation(post({ peer_user_id: PEER }));
    expect(res.status).toBe(401);
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("DM send rejects anonymous visitors", async () => {
    const res = await sendMessage(post({ body: "hi" }), { params: Promise.resolve({ id: PEER }) });
    expect(res.status).toBe(401);
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("DM create works for an account", async () => {
    accountId = "11111111-1111-4111-8111-111111111111";
    const res = await createConversation(post({ peer_user_id: PEER }));
    expect(res.status).toBe(200);
  });

  it("gaming profile returns 401 for guests and touches no DB rows", async () => {
    const res = await gamingProfile();
    expect(res.status).toBe(401);
    expect(getOrCreate).not.toHaveBeenCalled();
    expect(dbCalls).toHaveLength(0);
  });

  it("gaming session start returns 401 for guests", async () => {
    const res = await gamingStart(post({ gameId: "g1" }) as never);
    expect(res.status).toBe(401);
    expect(getOrCreate).not.toHaveBeenCalled();
  });
});
