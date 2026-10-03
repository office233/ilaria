/** Audit food-go (fix2): logică pură — opțiuni meniu, tranziții admin/sistem, poze stoc, fus orar, share TTL. */
import { describe, it, expect } from "vitest";
import { validateOptionSelection, type MenuOption } from "@/lib/food/menu-options";
import { checkTransition } from "@/lib/food/order-status";
import { isStockPhoto, toMerchantSummary, type MerchantRow } from "@/lib/food/merchant-view";
import { isOpenNow, merchantTimezone } from "@/lib/merchants/hours";
import { shareTtlAfterEndMinutes } from "@/lib/rides/share";

const SIZE: MenuOption = {
  name: "Mărime",
  required: true,
  choices: [
    { name: "Mică", price_cents: 0 },
    { name: "Mare", price_cents: 500 },
  ],
};
const EXTRA: MenuOption = {
  name: "Extra",
  max: 2,
  choices: [
    { id: "cheese", name: "Brânză", price_cents: 300 },
    { id: "bacon", name: "Bacon", price_cents: 400 },
    { id: "egg", name: "Ou", price_cents: 200 },
  ],
};

describe("validateOptionSelection (audit #15)", () => {
  it("prices valid selections server-side", () => {
    const r = validateOptionSelection([SIZE, EXTRA], ["Mărime:Mare", "cheese", "bacon"]);
    expect(r).toEqual({
      ok: true,
      extra_cents: 1200,
      chosen: [
        { id: "Mărime:Mare", name: "Mare", price_cents: 500 },
        { id: "cheese", name: "Brânză", price_cents: 300 },
        { id: "bacon", name: "Bacon", price_cents: 400 },
      ],
    });
  });

  it("enforces required groups", () => {
    expect(validateOptionSelection([SIZE, EXTRA], ["cheese"])).toEqual({ ok: false, code: "option_required", option: "Mărime" });
  });

  it("enforces max (explicit and the UI default of 1)", () => {
    expect(validateOptionSelection([SIZE, EXTRA], ["Mărime:Mică", "cheese", "bacon", "egg"])).toMatchObject({ code: "option_max", option: "Extra" });
    expect(validateOptionSelection([SIZE], ["Mărime:Mică", "Mărime:Mare"])).toMatchObject({ code: "option_max" });
  });

  it("rejects unknown and duplicate ids; accepts a unique name (re-order)", () => {
    expect(validateOptionSelection([SIZE], ["Mărime:XXL"])).toMatchObject({ code: "invalid_option" });
    expect(validateOptionSelection([EXTRA, SIZE], ["cheese", "cheese", "Mărime:Mică"])).toMatchObject({ code: "invalid_option" });
    expect(validateOptionSelection([SIZE], ["Mare"])).toMatchObject({ ok: true, extra_cents: 500 });
  });
});

describe("order transitions for admin / system (audit #7)", () => {
  it("admin can cancel from any non-final state, merchant only until preparing", () => {
    for (const from of ["placed", "accepted", "preparing", "ready", "picked_up", "delivering"]) {
      expect(checkTransition(from, "cancelled", "admin")).toEqual({ ok: true });
    }
    expect(checkTransition("delivered", "cancelled", "admin")).toMatchObject({ ok: false });
    expect(checkTransition("ready", "cancelled", "merchant")).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(checkTransition("preparing", "cancelled", "merchant")).toEqual({ ok: true });
  });

  it("system (watchdog) only cancels unaccepted orders; admin can mark delivered", () => {
    expect(checkTransition("placed", "cancelled", "system")).toEqual({ ok: true });
    expect(checkTransition("accepted", "cancelled", "system")).toMatchObject({ ok: false });
    expect(checkTransition("picked_up", "delivered", "admin")).toEqual({ ok: true });
    expect(checkTransition("ready", "delivered", "admin")).toMatchObject({ ok: false });
  });
});

describe("OSM stock photos (audit #26)", () => {
  const row: MerchantRow = {
    id: "m", kind: "restaurant", name: "X", slug: "x", description: null, cuisine_types: ["pizza"], address: null,
    location_city: "Cluj", delivery_fee_cents: null, min_order_cents: null, avg_prep_minutes: null, opening_hours: {},
    is_open_override: null, image_url: "https://images.unsplash.com/photo-1?w=600", listing_mode: "suggest_only",
  };

  it("detects Unsplash and hides it on unclaimed profiles only", () => {
    expect(isStockPhoto("https://images.unsplash.com/photo-1")).toBe(true);
    expect(isStockPhoto("https://commons.wikimedia.org/x.jpg")).toBe(false);
    expect(isStockPhoto("not a url")).toBe(false);
    expect(toMerchantSummary(row).image_url).toBeNull();
    expect(toMerchantSummary({ ...row, is_claimed: true }).image_url).toBe(row.image_url);
    expect(toMerchantSummary({ ...row, image_url: "https://media.swypik.com/a.jpg" }).image_url).toBe("https://media.swypik.com/a.jpg");
  });
});

describe("merchant timezone (audit #24)", () => {
  it("maps the country and falls back to the default", () => {
    expect(merchantTimezone("RO")).toBe("Europe/Bucharest");
    expect(merchantTimezone("pt")).toBe("Europe/Lisbon");
    expect(merchantTimezone(null)).toBe("Europe/Bucharest");
  });

  it("evaluates opening hours in the merchant's zone", () => {
    const hours = { mon: [["08:00", "09:00"]] as [string, string][] };
    const monday0730utc = new Date("2026-09-28T07:30:00Z"); // 10:30 București, 08:30 Lisabona
    expect(isOpenNow(hours, null, monday0730utc, "Europe/Bucharest")).toBe(false);
    expect(isOpenNow(hours, null, monday0730utc, "Europe/Lisbon")).toBe(true);
  });
});

describe("share link TTL (audit #9)", () => {
  it("defaults to 15 min and validates the env value", () => {
    expect(shareTtlAfterEndMinutes(undefined)).toBe(15);
    expect(shareTtlAfterEndMinutes("30")).toBe(30);
    expect(shareTtlAfterEndMinutes("0")).toBe(15);
    expect(shareTtlAfterEndMinutes("99999")).toBe(15);
  });
});
