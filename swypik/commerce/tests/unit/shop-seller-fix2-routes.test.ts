import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock-uri comune ─────────────────────────────────────────────────────────
let sellerId: string | null = "seller-1";
type Handler = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } | undefined;
let handler: Handler = () => undefined;
const calls: Array<{ sql: string; params: unknown[] }> = [];

vi.mock("@/lib/security/seller-auth", () => ({ getSellerSessionId: async () => sellerId }));
vi.mock("@/lib/email/service", () => ({ sendMagicLink: async () => true }));
vi.mock("@/lib/redis", () => ({ getRedis: () => null }));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 10 }),
  getClientIP: () => "127.0.0.1",
}));
vi.mock("@/lib/social/proxy", () => ({ proxyToSocialApi: async () => null }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/db", () => {
  const dbQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return handler(sql, params) ?? { rows: [], rowCount: 0 };
  });
  return { dbQuery, withTransaction: async <T,>(fn: (q: typeof dbQuery) => Promise<T>) => fn(dbQuery) };
});

beforeEach(() => {
  sellerId = "seller-1";
  handler = () => undefined;
  calls.length = 0;
});

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_V = "33333333-3333-4333-8333-333333333333";

function jsonReq(url: string, body: unknown, method = "POST") {
  return new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

// ── checkout vechi retras ───────────────────────────────────────────────────
describe("checkout vechi /api/checkout și /api/v1/checkout", () => {
  it("răspund 410 cu cod stabil și înlocuitor", async () => {
    const { POST } = await import("@/app/api/checkout/route");
    const res = await POST();
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: "legacy_checkout_retired", replacement: "/api/checkout/create-intent" });

    const v1 = await import("@/app/api/v1/[...path]/route");
    const res2 = await v1.POST(jsonReq("http://localhost/api/v1/checkout", { items: [] }), {
      params: Promise.resolve({ path: ["checkout"] }),
    });
    expect(res2.status).toBe(410);
    expect((await res2.json()).code).toBe("legacy_checkout_retired");
  }, 60_000);
});

// ── e-Factura ───────────────────────────────────────────────────────────────
const INVOICE_ROW = {
  id: UUID_A,
  invoice_number: "FACT-0007",
  created_at: "2026-09-28T10:00:00Z",
  currency: "RON",
  vat_rate_pct: "21",
  status: "issued",
  subtotal_cents: 8264,
  vat_cents: 1736,
  total_cents: 10000,
  items: [{ title: "Cană", quantity: 1, price: 100 }],
  client_name: "Client SRL",
  client_cui: "14399840",
  client_address: null,
  client_details: { street: "Str. A 1", city: "Iași", county: "RO-IS", country: "RO" },
  supplier_snapshot: null as unknown,
};
const SELLER_ROW = {
  name: "Shop",
  cui: "RO18547290",
  email: "s@x.ro",
  phone: null,
  business_details: { legalName: "Shop Real SRL", address: "Str. B 2", city: "Cluj-Napoca", county: "RO-CJ", country: "RO" },
};

describe("GET /api/seller/invoices/[id]/efactura", () => {
  const params = { params: Promise.resolve({ id: UUID_A }) };

  it("fără sesiune → 401", async () => {
    sellerId = null;
    const { GET } = await import("@/app/api/seller/invoices/[id]/efactura/route");
    const res = await GET(new Request(`http://localhost/api/seller/invoices/${UUID_A}/efactura`), params);
    expect(res.status).toBe(401);
  });

  it("date complete → XML UBL cu furnizorul real, ca attachment", async () => {
    handler = (sql) => {
      if (sql.includes("FROM seller_invoices")) return { rows: [INVOICE_ROW] };
      if (sql.includes("FROM sellers")) return { rows: [SELLER_ROW] };
    };
    const { GET } = await import("@/app/api/seller/invoices/[id]/efactura/route");
    const res = await GET(new Request(`http://localhost/api/seller/invoices/${UUID_A}/efactura`), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const xml = await res.text();
    expect(xml).toContain("Shop Real SRL");
    expect(xml).toContain("<cbc:CompanyID>RO18547290</cbc:CompanyID>");
    expect(calls[0].params).toEqual([UUID_A, "seller-1"]);
  });

  it("profil incomplet → 422 cu codurile lipsă (și ?check=1 → JSON)", async () => {
    handler = (sql) => {
      if (sql.includes("FROM seller_invoices")) return { rows: [INVOICE_ROW] };
      if (sql.includes("FROM sellers")) return { rows: [{ ...SELLER_ROW, cui: null, business_details: {} }] };
    };
    const { GET } = await import("@/app/api/seller/invoices/[id]/efactura/route");
    const res = await GET(new Request(`http://localhost/api/seller/invoices/${UUID_A}/efactura`), params);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("efactura_invalid");
    expect(body.errors).toEqual(expect.arrayContaining(["supplier_cui_invalid", "supplier_street_missing"]));

    const check = await GET(new Request(`http://localhost/api/seller/invoices/${UUID_A}/efactura?check=1`), params);
    expect(await check.json()).toMatchObject({ success: true, valid: false });
  });

  it("link semnat funcționează fără sesiune (browser extern din aplicație)", async () => {
    handler = (sql) => {
      if (sql.includes("FROM seller_invoices")) return { rows: [INVOICE_ROW] };
      if (sql.includes("FROM sellers")) return { rows: [SELLER_ROW] };
    };
    const { signSellerFileToken } = await import("@/lib/seller/file-links");
    const token = signSellerFileToken("seller-1", "invoice_pdf", UUID_A);
    sellerId = null;
    const { GET } = await import("@/app/api/seller/invoices/[id]/pdf/route");
    const res = await GET(new Request(`http://localhost/api/seller/invoices/${UUID_A}/pdf?t=${encodeURIComponent(token)}&locale=en`), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("inline");
    // Același token nu deschide XML-ul.
    const { GET: xmlGet } = await import("@/app/api/seller/invoices/[id]/efactura/route");
    const res2 = await xmlGet(new Request(`http://localhost/api/seller/invoices/${UUID_A}/efactura?t=${encodeURIComponent(token)}`), params);
    expect(res2.status).toBe(401);
  });
});

// ── POS: stoc negestionat + variante ────────────────────────────────────────
describe("POST /api/seller/pos/sale", () => {
  it("stoc negestionat nu blochează vânzarea", async () => {
    handler = (sql) => {
      if (sql.includes("UPDATE marketplace_products")) return { rows: [{ title: "Cană" }], rowCount: 1 };
      if (sql.includes("seller_sequences")) return { rows: [{ value: 1 }] };
      if (sql.includes("INSERT INTO seller_pos_sales")) return { rows: [{ id: UUID_V, receipt_number: "POS-1", created_at: "x" }] };
    };
    const { POST } = await import("@/app/api/seller/pos/sale/route");
    const res = await POST(jsonReq("http://localhost/api/seller/pos/sale", { items: [{ id: UUID_A, quantity: 3, price: 10 }], paymentMethod: "cash" }));
    expect(res.status).toBe(201);
    expect((await res.json()).saleId).toBe(UUID_V);
    const update = calls.find((c) => c.sql.includes("UPDATE marketplace_products"))!;
    expect(update.sql).toContain("NULLIF(metadata->>'available_stock', '') IS NULL");
  });

  it("vânzarea pe variantă scade stocul variantei", async () => {
    handler = (sql) => {
      if (sql.includes("UPDATE marketplace_product_variants")) return { rows: [{ title: "M", product_title: "Tricou" }], rowCount: 1 };
      if (sql.includes("seller_sequences")) return { rows: [{ value: 1 }] };
      if (sql.includes("INSERT INTO seller_pos_sales")) return { rows: [{ id: UUID_V, receipt_number: "POS-1", created_at: "x" }] };
    };
    const { POST } = await import("@/app/api/seller/pos/sale/route");
    const res = await POST(
      jsonReq("http://localhost/api/seller/pos/sale", { items: [{ id: UUID_A, variantId: UUID_V, quantity: 1, price: 50 }], paymentMethod: "card" }),
    );
    expect(res.status).toBe(201);
    expect(calls.some((c) => c.sql.includes("UPDATE marketplace_products\n"))).toBe(false);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO seller_pos_sales"))!;
    expect(String(insert.params[2])).toContain("Tricou — M");
  });

  it("produs cu variante vândut fără variantă → 409 variant_required", async () => {
    handler = (sql) => {
      if (sql.includes("UPDATE marketplace_products")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT id FROM marketplace_products")) return { rows: [{ id: UUID_A }] };
      if (sql.includes("FROM marketplace_product_variants")) return { rows: [{ id: UUID_V }] };
    };
    const { POST } = await import("@/app/api/seller/pos/sale/route");
    const res = await POST(jsonReq("http://localhost/api/seller/pos/sale", { items: [{ id: UUID_A, quantity: 1, price: 50 }], paymentMethod: "cash" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("variant_required");
  });
});

// ── Ads: doar produsele proprii ─────────────────────────────────────────────
describe("POST /api/seller/ads", () => {
  it("respinge un produs al altui seller și tipul mystery_drop", async () => {
    const { POST } = await import("@/app/api/seller/ads/route");
    const res = await POST(jsonReq("http://localhost/api/seller/ads", { campaignName: "X", productId: UUID_A }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("product_not_owned");
    expect(calls.some((c) => c.sql.includes("INSERT INTO seller_ads"))).toBe(false);

    const res2 = await POST(jsonReq("http://localhost/api/seller/ads", { campaignName: "X", adType: "mystery_drop" }));
    expect(res2.status).toBe(400);
    expect((await res2.json()).error).toBe("validation_error");
  });
});

// ── Setări: CUI invalid → cod, nu text ──────────────────────────────────────
describe("POST /api/seller/settings", () => {
  it("CUI cu cifră de control greșită → 400 invalid_cui", async () => {
    const { POST } = await import("@/app/api/seller/settings/route");
    const res = await POST(jsonReq("http://localhost/api/seller/settings", { username: "shop1", cui: "RO18547291" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_cui");
  });

  it("salvează adresa fiscală cu județul normalizat", async () => {
    handler = (sql) => {
      if (sql.includes("SELECT user_id, business_details")) return { rows: [{ user_id: null, business_details: { iban: "" } }] };
    };
    const { POST } = await import("@/app/api/seller/settings/route");
    const res = await POST(
      jsonReq("http://localhost/api/seller/settings", { username: "shop1", cui: "ro 18547290", street: "Str. B 2", city: "Cluj-Napoca", county: "Cluj" }),
    );
    expect(res.status).toBe(200);
    const update = calls.find((c) => c.sql.includes("UPDATE sellers"))!;
    expect(update.params[1]).toBe("RO18547290");
    expect(update.params[3]).toMatchObject({ address: "Str. B 2", county: "RO-CJ", country: "RO" });
  });
});

// ── Login seller: email normalizat ──────────────────────────────────────────
describe("POST /api/seller/auth", () => {
  it("caută sellerul după emailul normalizat (lower/trim)", async () => {
    const { POST } = await import("@/app/api/seller/auth/route");
    const res = await POST(jsonReq("http://localhost/api/seller/auth", { action: "login", email: "Shop@Example.RO" }));
    expect(res.status).toBe(200);
    const lookup = calls.find((c) => c.sql.includes("FROM sellers WHERE lower(email) = $1"));
    expect(lookup?.params).toEqual(["shop@example.ro"]);
  }, 60_000);
});
