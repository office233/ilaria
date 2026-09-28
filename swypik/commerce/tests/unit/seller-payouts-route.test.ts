import { describe, it, expect, vi, beforeEach } from "vitest";

let sellerId: string | null = "s1";
const requestSellerPayout = vi.fn();

vi.mock("@/lib/security/seller-auth", () => ({ getSellerSessionId: async () => sellerId }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/seller/payouts", () => ({
  requestSellerPayout: (...a: unknown[]) => requestSellerPayout(...a),
  getSellerPayoutSetup: vi.fn(async () => ({ method: "bank", connectAvailable: false, connectReady: false, minCents: 5000, windowDays: 14, currency: "RON", iban: "RO49AAAA1B31007593840000", accountId: "acct_secret" })),
  getSellerBalance: vi.fn(async () => ({ availableCents: 100, onHoldCents: 0, requestedCents: 0, paidTotalCents: 0, paid90Cents: 0 })),
  listSellerPayoutRequests: vi.fn(async () => []),
  maskIban: (i: string | null) => (i ? `•••• ${i.slice(-4)}` : null),
}));

import { GET, POST } from "@/app/api/seller/payouts/route";

const post = (body: unknown) => POST(new Request("http://x/api/seller/payouts", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  sellerId = "s1";
  requestSellerPayout.mockReset();
});

describe("/api/seller/payouts", () => {
  it("GET nu expune IBAN-ul complet sau contul Stripe", async () => {
    const json = await (await GET()).json();
    expect(json.setup.ibanMasked).toBe("•••• 0000");
    expect(JSON.stringify(json)).not.toContain("RO49AAAA");
    expect(JSON.stringify(json)).not.toContain("acct_secret");
  });

  it("POST fără sesiune → 401", async () => {
    sellerId = null;
    expect((await post({})).status).toBe(401);
  });

  it("POST cu IBAN invalid → 400 invalid_iban (normalizează spațiile)", async () => {
    const res = await post({ iban: "123" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_iban");
    requestSellerPayout.mockResolvedValue({ ok: true, id: "pr1", amountCents: 6000, method: "bank" });
    await post({ iban: "ro49 aaaa 1b31 0075 9384 0000" });
    expect(requestSellerPayout).toHaveBeenCalledWith({ sellerId: "s1", iban: "RO49AAAA1B31007593840000" });
  });

  it("coduri de business → statusuri stabile", async () => {
    requestSellerPayout.mockResolvedValue({ ok: false, code: "below_minimum", availableCents: 100 });
    const r1 = await post({});
    expect(r1.status).toBe(422);
    expect(await r1.json()).toMatchObject({ error: "below_minimum", availableCents: 100 });
    requestSellerPayout.mockResolvedValue({ ok: false, code: "open_request_exists" });
    expect((await post({})).status).toBe(409);
  });

  it("cerere concurentă prinsă de indexul unic (23505) → 409", async () => {
    requestSellerPayout.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    const res = await post({});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("open_request_exists");
  });
});
