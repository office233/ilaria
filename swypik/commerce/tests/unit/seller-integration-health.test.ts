import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock("@/lib/db", () => ({ dbQuery }));
vi.mock("@/lib/queue/video-jobs", () => ({ videoQueueBackend: () => "postgres" }));

import { checkSellerIntegrationSync } from "@/lib/health";

beforeEach(() => {
  dbQuery.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T18:30:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkSellerIntegrationSync", () => {
  it("is healthy with a fresh cron, empty queue and active integrations", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{
        pending: 0,
        failed: 0,
        processing: 0,
        expired_leases: 0,
        integrations_active: 3,
        integrations_degraded: 0,
        integrations_unavailable: 0,
        integrations_pending: 0,
        last_success_at: "2026-09-29T18:29:20Z",
        last_failure_at: null,
      }],
      rowCount: 1,
    });
    const result = await checkSellerIntegrationSync();
    expect(result.status).toBe("ok");
    expect(result.detail).toMatchObject({
      pending: 0,
      failed: 0,
      integrations_active: 3,
      cron_age_s: 40,
    });
  });

  it("degrades when provider setup or retries need attention", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{
        pending: 2,
        failed: 1,
        processing: 0,
        expired_leases: 0,
        integrations_active: 1,
        integrations_degraded: 1,
        integrations_unavailable: 0,
        integrations_pending: 0,
        last_success_at: "2026-09-29T18:28:00Z",
        last_failure_at: "2026-09-29T18:27:00Z",
      }],
      rowCount: 1,
    });
    expect((await checkSellerIntegrationSync()).status).toBe("degraded");
  });

  it("errors when the minute cron has not succeeded for over 15 minutes", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{
        pending: 0,
        failed: 0,
        processing: 0,
        expired_leases: 0,
        integrations_active: 1,
        integrations_degraded: 0,
        integrations_unavailable: 0,
        integrations_pending: 0,
        last_success_at: "2026-09-29T18:00:00Z",
        last_failure_at: null,
      }],
      rowCount: 1,
    });
    expect((await checkSellerIntegrationSync()).status).toBe("error");
  });
});
