import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ fail: new Set<string>(), calls: [] as { sql: string; params: unknown[] }[] }));

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.calls.push({ sql, params });
    for (const f of h.fail) if (sql.includes(f)) throw new Error(`relation ${f} does not exist`);
    if (sql.includes("GROUP BY 1")) return { rows: [{ currency: "RON", cents: "123400" }] };
    if (sql.includes("GROUP BY kind")) return { rows: [{ kind: "creator", c: "2" }] };
    return { rows: [{ c: "3" }] };
  }),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { ADMIN_NAV, activeNavHref, navForRole } from "@/lib/admin/nav";
import { ADMIN_PERMISSIONS } from "@/lib/admin/permissions";
import { getAdminKpis, parseKpiRange } from "@/lib/admin/kpis";

beforeEach(() => {
  h.fail.clear();
  h.calls = [];
});

describe("admin nav config", () => {
  const hrefs = ADMIN_NAV.flatMap((g) => g.items.map((i) => i.href));

  it("keeps every module page, including the ones built by other modules", () => {
    for (const href of [
      "/admin",
      "/admin/moderation",
      "/admin/users",
      "/admin/audit",
      "/admin/merchant-claims",
      "/admin/missions",
      "/admin/creator-payouts",
      "/admin/movies",
      "/admin/go",
    ]) {
      expect(hrefs).toContain(href);
    }
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("every item declares a known permission and a unique id", () => {
    const ids = ADMIN_NAV.flatMap((g) => g.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of ADMIN_NAV) for (const i of g.items) expect(ADMIN_PERMISSIONS).toContain(i.permission);
  });

  it("filters by role and drops empty groups", () => {
    const finance = navForRole("finance").flatMap((g) => g.items.map((i) => i.href));
    expect(finance).toContain("/admin/creator-payouts");
    expect(finance).not.toContain("/admin/moderation");
    expect(navForRole("moderator").some((g) => g.id === "finance")).toBe(false);
    expect(navForRole("owner").flatMap((g) => g.items)).toHaveLength(hrefs.length);
  });

  it("marks the most specific entry active", () => {
    expect(activeNavHref("/admin")).toBe("/admin");
    expect(activeNavHref("/admin/moderation/abc")).toBe("/admin/moderation");
    expect(activeNavHref("/admin/unknown")).toBeNull();
  });
});

describe("admin KPIs", () => {
  it("parses the range with a 7d default", () => {
    expect(parseKpiRange("24h")).toBe("24h");
    expect(parseKpiRange("1y")).toBe("7d");
    expect(parseKpiRange(undefined)).toBe("7d");
  });

  it("computes every metric with the range interval", async () => {
    const k = await getAdminKpis("30d");
    expect(k).toMatchObject({
      orders: 3,
      gmv: [{ currency: "RON", cents: 123400 }],
      newUsers: 3,
      videosPending: 3,
      videosFlagged: 3,
      openReports: 3,
      payoutRequests: { courier: 0, creator: 2 },
      failedJobs: { cron: 3, video: 3 },
    });
    const orders = h.calls.find((c) => c.sql.includes("COUNT(*) AS c FROM commerce_orders"));
    expect(orders?.params[0]).toBe("30 days");
  });

  it("a missing table blanks only that metric", async () => {
    h.fail.add("payout_requests");
    h.fail.add("cron_runs");
    const k = await getAdminKpis("24h");
    expect(k.payoutRequests).toBeNull();
    expect(k.failedJobs).toBeNull();
    expect(k.orders).toBe(3);
  });
});
