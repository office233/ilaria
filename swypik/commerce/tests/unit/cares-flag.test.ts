import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 2026-09-26 (w1-removals-data): Swypik Cares (donații) e ascuns până există un
 * partener ONG — FEATURE_CARES OFF implicit. Toate API-urile Cares răspund 410
 * `feature_frozen` fără să atingă DB-ul/Stripe (paginile /cares și /cauze dau notFound()).
 */

const dbQueryMock = vi.fn(async () => ({ rows: [], rowCount: 0 }));
vi.mock("@/lib/db", () => ({
  dbQuery: () => dbQueryMock(),
  withTransaction: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 10 }),
}));
vi.mock("@/lib/stripe/checkout", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const ORIGINAL = process.env.FEATURE_CARES;

beforeEach(() => {
  delete process.env.FEATURE_CARES;
  vi.resetModules();
  dbQueryMock.mockClear();
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.FEATURE_CARES;
  else process.env.FEATURE_CARES = ORIGINAL;
});

function req(url: string, method = "GET", body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function expectFrozen(res: Response) {
  expect(res.status).toBe(410);
  const body = await res.json();
  expect(body.error).toBe("feature_frozen");
  expect(body.feature).toBe("cares");
}

describe("FEATURE_CARES off (default)", () => {
  it("defaults to disabled on server and client", async () => {
    const server = await import("@/lib/feature-flags");
    const client = await import("@/lib/feature-flags-client");
    expect(server.isEnabled("cares")).toBe(false);
    expect(client.isEnabledClient("cares")).toBe(false);
  });

  it("POST /api/donations is frozen and never touches the DB", async () => {
    const { POST } = await import("@/app/api/donations/route");
    await expectFrozen(await POST(req("http://localhost/api/donations", "POST", {
      campaign_id: "11111111-1111-4111-8111-111111111111",
      amount: 10,
    })));
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it("GET /api/campaigns is frozen", async () => {
    const { GET } = await import("@/app/api/campaigns/route");
    await expectFrozen(await GET(req("http://localhost/api/campaigns")));
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it("campaign management + expenses + causes APIs are frozen", async () => {
    const manage = await import("@/app/api/campaigns/manage/route");
    await expectFrozen(await manage.GET());
    await expectFrozen(await manage.POST(req("http://localhost/api/campaigns/manage", "POST", {})));
    await expectFrozen(await manage.PATCH(req("http://localhost/api/campaigns/manage", "PATCH", {})));
    const expenses = await import("@/app/api/campaigns/manage/expenses/route");
    await expectFrozen(await expenses.GET(req("http://localhost/api/campaigns/manage/expenses")));
    await expectFrozen(await expenses.POST(req("http://localhost/api/campaigns/manage/expenses", "POST", {})));
    const causes = await import("@/app/api/causes/route");
    await expectFrozen(await causes.GET());
    await expectFrozen(await causes.POST(req("http://localhost/api/causes", "POST", {})));
    expect(dbQueryMock).not.toHaveBeenCalled();
  });
});

describe("FEATURE_CARES=1", () => {
  it("lets the public campaigns API through to the DB", async () => {
    process.env.FEATURE_CARES = "1";
    const { GET } = await import("@/app/api/campaigns/route");
    const res = await GET(req("http://localhost/api/campaigns"));
    expect(res.status).not.toBe(410);
    expect(dbQueryMock).toHaveBeenCalled();
  });
});
