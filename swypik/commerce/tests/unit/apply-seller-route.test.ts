import { describe, it, expect, vi, beforeEach } from "vitest";

let insertRows: { id: string }[] = [];
const opsAlertMock = vi.fn(async (_input: { kind: string; label: string; fields: Record<string, string>; adminPath: string }) => true);

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async () => ({ rows: insertRows, rowCount: insertRows.length })),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ success: true })),
  getClientIP: () => "1.2.3.4",
}));
vi.mock("@/lib/email/templates/ops", () => ({ sendOpsApplicationAlert: (input: any) => opsAlertMock(input) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from "@/app/api/apply-seller/route";

const body = {
  companyName: "Acme <script>alert(1)</script>",
  cui: "RO123\r\nBcc: x@evil.com",
  email: "Owner@Acme.ro",
  phone: "0712345678",
  productType: "Fashion",
};
const req = () =>
  new Request("https://swypik.com/api/apply-seller", { method: "POST", body: JSON.stringify(body) });

describe("POST /api/apply-seller", () => {
  beforeEach(() => {
    opsAlertMock.mockClear();
    process.env.OPS_ALERT_EMAIL = "ops@swypik.com";
  });

  it("notifies ops through the shared ops template (escaping lives in lib/email)", async () => {
    insertRows = [{ id: "s-1" }];
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, status: "received" });
    expect(opsAlertMock).toHaveBeenCalledTimes(1);
    const input = opsAlertMock.mock.calls[0][0];
    expect(input.kind).toBe("seller");
    expect(input.adminPath).toBe("/admin/sellers");
    expect(input.fields.company).toContain("<script>");
  });

  it("answers identically but does not notify ops when an existing non-pending seller is left untouched", async () => {
    insertRows = [];
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, status: "received" });
    expect(opsAlertMock).not.toHaveBeenCalled();
  });
});
