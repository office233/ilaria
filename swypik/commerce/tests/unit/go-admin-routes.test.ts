import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  admin: true,
  audit: vi.fn(async () => undefined),
  assign: vi.fn(async () => ({ ok: true, job_id: "job-1", previous_driver_id: null as string | null })),
  waive: vi.fn(async () => true),
  cancel: vi.fn(async () => ({ ok: true, status: "cancelled", cancel_fee_cents: 0 })),
  settings: { card_enabled: true, cash_enabled: false, free_cancel_grace_seconds: 120, fare_overrun_cap_bps: 2000, payment_auth_ttl_minutes: 15, required_driver_documents: [] as string[] },
}));

vi.mock("@/lib/admin/guard", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireAdmin: async () => (h.admin ? { kind: "admin_user", role: "ops" } : NextResponse.json({ error: "unauthorized" }, { status: 401 })),
  };
});
vi.mock("@/lib/security/admin-audit", () => ({ logAdminAction: h.audit }));
vi.mock("@/lib/rides/admin-ops", () => ({ adminAssignRide: h.assign, waiveCancelFee: h.waive }));
vi.mock("@/lib/rides/transitions", () => ({ cancelRide: h.cancel }));
vi.mock("@/lib/rides/settings", async () => {
  const { z } = await import("zod");
  return {
    getGoSettings: async () => ({ ...h.settings }),
    updateGoSettings: async (patch: Record<string, unknown>) => {
      Object.assign(h.settings, patch);
      return { ...h.settings };
    },
    GoSettingsPatchSchema: z.object({ cash_enabled: z.boolean(), free_cancel_grace_seconds: z.number().int() }).partial(),
  };
});

import { POST as rideAction } from "@/app/api/admin/go/rides/[id]/route";
import { PATCH as patchSettings } from "@/app/api/admin/go/settings/route";

const RIDE = "11111111-1111-4111-8111-111111111111";
const COURIER = "22222222-2222-4222-8222-222222222222";
const call = (body: unknown, id = RIDE) =>
  rideAction(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.admin = true;
  h.settings.cash_enabled = false;
});

describe("POST /api/admin/go/rides/[id]", () => {
  it("rejects non-admins and invalid ids", async () => {
    h.admin = false;
    expect((await call({ action: "cancel" })).status).toBe(401);
    h.admin = true;
    expect((await call({ action: "cancel" }, "nope")).status).toBe(400);
    expect((await call({ action: "assign", courier_id: "x" })).status).toBe(400);
  });

  it("assigns a driver and audits it (reassign when a driver existed)", async () => {
    expect((await call({ action: "assign", courier_id: COURIER })).status).toBe(200);
    expect(h.assign).toHaveBeenCalledWith(RIDE, COURIER);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "go.ride_assign", targetId: RIDE }));
    h.assign.mockResolvedValueOnce({ ok: true, job_id: "job-1", previous_driver_id: "c-old" });
    await call({ action: "assign", courier_id: COURIER });
    expect(h.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "go.ride_reassign" }));
  });

  it("surfaces assignment conflicts without auditing", async () => {
    h.assign.mockResolvedValueOnce({ ok: false, error: "driver_busy", code: 409 } as never);
    const res = await call({ action: "assign", courier_id: COURIER });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "driver_busy" });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("force-cancels as admin and waives owed fees", async () => {
    await call({ action: "cancel", reason: "duplicate" });
    expect(h.cancel).toHaveBeenCalledWith({ rideId: RIDE, actor: "admin", reason: "duplicate" });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "go.ride_cancel" }));
    await call({ action: "waive_fee" });
    expect(h.waive).toHaveBeenCalledWith(RIDE);
    expect(h.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "go.cancel_fee_waive" }));
  });
});

describe("PATCH /api/admin/go/settings", () => {
  it("updates and audits old → new values", async () => {
    const res = await patchSettings(
      new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ cash_enabled: true }) }),
    );
    expect(res.status).toBe(200);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "go.settings_update", details: { cash_enabled: { from: false, to: true } } }),
    );
  });

  it("rejects invalid input", async () => {
    const res = await patchSettings(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ cash_enabled: "yes" }) }));
    expect(res.status).toBe(400);
  });
});
