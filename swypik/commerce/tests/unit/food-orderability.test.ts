import { describe, it, expect, vi, beforeEach } from "vitest";

/** w2-food: comandabilitate (program pe server, token guest), listă onestă, sugestii. */

vi.mock("@/lib/logger", () => {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => logger };
  return { logger };
});
vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => null }));
let rlOk = true;
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: rlOk, remaining: 1 }),
  getClientIP: () => "203.0.113.9",
}));
vi.mock("@/lib/dispatch/auto", () => ({ maybeAutoDispatch: vi.fn() }));
vi.mock("@/lib/payments/eats-stripe", () => ({ createLocalOrderPaymentIntent: vi.fn() }));
vi.mock("@/lib/pricing/delivery", () => ({
  resolveDeliveryFee: vi.fn(async () => ({ fee_cents: 900, source: "fixed", zone_id: null, distance_km: null, surge_multiplier: null, breakdown: null })),
}));

let merchantRow: Record<string, unknown> | null = null;
const txParams: unknown[][] = [];
const dbQuery = vi.fn(async (sql: string, _p?: unknown[]) => {
  if (sql.includes("FROM local_merchants WHERE id")) return { rows: merchantRow ? [merchantRow] : [], rowCount: 1 };
  if (sql.includes("FROM menu_items WHERE merchant_id")) {
    return { rows: [{ id: ITEM, name: "Ciorbă", price_cents: 2500, currency: "RON", options: [], is_available: true }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});
vi.mock("@/lib/db", () => ({
  dbQuery: (s: string, p?: unknown[]) => dbQuery(s, p),
  withTransaction: async (fn: (q: (s: string, p: unknown[]) => Promise<unknown>) => Promise<unknown>) =>
    fn(async (_s, p) => {
      txParams.push(p);
      return { rows: [{ id: "o1", order_number: "LO-1", status: "placed", total_cents: 3400 }], rowCount: 1 };
    }),
}));

import { POST as placeOrder } from "@/app/api/local-orders/route";
import { buildMerchantListSql, parseMerchantListQuery } from "@/lib/food/merchant-list";
import { toMerchantSummary, type MerchantRow } from "@/lib/food/merchant-view";
import { cityKey } from "@/lib/food/city";
import { canonicalCuisine, cuisineMatchValues, normalizeCuisines } from "@/lib/merchants/cuisines";
import { guestTokenMatches, newGuestToken } from "@/lib/food/guest-token";
import { suggesterKey } from "@/lib/food/suggestions";

const MID = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const ALWAYS_OPEN = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [["00:00", "23:59"]]]));

function orderReq(): Request {
  return new Request("http://localhost/api/local-orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      merchant_id: MID,
      items: [{ menu_item_id: ITEM, qty: 1 }],
      customer_name: "Ana Pop",
      customer_phone: "+40711111111",
      delivery_address: "Str. Exemplu 1, București",
      delivery_lat: 44.43,
      delivery_lng: 26.1,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  txParams.length = 0;
  rlOk = true;
  merchantRow = { id: MID, status: "active", listing_mode: "orderable", is_open_override: null, opening_hours: ALWAYS_OPEN, min_order_cents: 0, avg_prep_minutes: 20 };
});

describe("POST /api/local-orders — orderability", () => {
  it("rejects orders when the restaurant is closed by its hours (server-side check)", async () => {
    merchantRow = { ...merchantRow, opening_hours: {} };
    const res = await placeOrder(orderReq());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("merchant_closed");
  });

  it("returns a stable code when below the minimum order", async () => {
    merchantRow = { ...merchantRow, min_order_cents: 5000 };
    const res = await placeOrder(orderReq());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("below_min_order");
  });

  it("gives guests a one-time tracking token and stores only its hash", async () => {
    const res = await placeOrder(orderReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.tracking_token).toBe("string");
    const storedHash = txParams[0].at(-1) as string;
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedHash).not.toBe(body.tracking_token);
    expect(guestTokenMatches(body.tracking_token, storedHash)).toBe(true);
  });

  it("uses the configured ETA (prep + travel max) for estimated_delivery_at", async () => {
    await placeOrder(orderReq());
    expect(txParams[0][14]).toBe(20 + 40);
  });
});

describe("merchant list query", () => {
  it("filters by accent-insensitive city key and all cuisine aliases", () => {
    const q = parseMerchantListQuery(new URL("http://x/api/merchants?city=București&cuisine=romanian&kind=restaurant"));
    const { sql, params } = buildMerchantListSql(q);
    expect(sql).toContain("m.city_key = $1");
    expect(params[0]).toBe("bucuresti");
    expect(sql).toContain("m.cuisine_types && $3::text[]");
    expect(params[2]).toEqual(expect.arrayContaining(["romanian", "romaneasca"]));
    expect(sql).toMatch(/ORDER BY \(m\.listing_mode = 'orderable'\) DESC/);
  });

  it("escapes LIKE wildcards in search and ignores invalid params", () => {
    const q = parseMerchantListQuery(new URL("http://x/api/merchants?q=50%25_off&kind=spaceship&sort=weird&limit=9999"));
    expect(q.kind).toBeUndefined();
    expect(q.sort).toBe("recommended");
    expect(q.limit).toBe(24);
    const { params } = buildMerchantListSql(q);
    expect(params[0]).toBe("%50\\%\\_off%");
  });

  it("uses geo instead of city when coordinates are given", () => {
    const { sql } = buildMerchantListSql(parseMerchantListQuery(new URL("http://x/?city=Iasi&lat=47.1&lng=27.6&sort=distance")));
    expect(sql).not.toContain("city_key");
    expect(sql).toContain("distance_km ASC");
  });
});

describe("toMerchantSummary — honest unclaimed listings", () => {
  const row: MerchantRow = {
    id: MID, kind: "restaurant", name: "Bistro", slug: "bistro", description: null, cuisine_types: ["romaneasca", "pizza"],
    address: null, location_city: "Iași", delivery_fee_cents: 0, min_order_cents: 3000, avg_prep_minutes: 15,
    opening_hours: ALWAYS_OPEN, is_open_override: null, image_url: null, listing_mode: "suggest_only", menu_count: 0, suggestion_count: 4,
  };
  it("hides fee, ETA, open badge and minimum for suggest_only merchants", () => {
    const s = toMerchantSummary(row);
    expect(s).toMatchObject({ is_orderable: false, delivery_fee_cents: null, eta_min: null, is_open: null, min_order_cents: null, suggestion_count: 4 });
    expect(s.cuisines).toEqual(["romanian", "pizza"]);
  });
  it("computes ETA from config for partners", () => {
    const s = toMerchantSummary({ ...row, listing_mode: "orderable", menu_count: 3 });
    expect(s).toMatchObject({ is_orderable: true, has_menu: true, eta_min: 40, eta_max: 55, delivery_fee_cents: 0, is_open: true });
  });
});

describe("helpers", () => {
  it("normalizes city names and cuisines", () => {
    expect(cityKey("  BUCUREȘTI ")).toBe("bucuresti");
    expect(cityKey("Bucureşti")).toBe("bucuresti");
    expect(canonicalCuisine("Asiatica")).toBe("asian");
    expect(canonicalCuisine("fast food")).toBe("fast_food");
    expect(normalizeCuisines(["burger", "burgers", "unknown-thing"])).toEqual(["burgers"]);
    expect(cuisineMatchValues("nope")).toEqual([]);
  });
  it("guest tokens verify only against their own hash", () => {
    const a = newGuestToken();
    const b = newGuestToken();
    expect(guestTokenMatches(a.token, a.hash)).toBe(true);
    expect(guestTokenMatches(b.token, a.hash)).toBe(false);
    expect(guestTokenMatches("short", a.hash)).toBe(false);
    expect(guestTokenMatches(a.token, null)).toBe(false);
  });
  it("hashes suggester identity (never stores raw IPs)", () => {
    const k = suggesterKey(null, "203.0.113.9");
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).not.toContain("203");
    expect(suggesterKey("u1", "203.0.113.9")).not.toBe(k);
    expect(suggesterKey(null, null)).toBeNull();
  });
});
