import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbQuery, cityFromCoords } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  cityFromCoords: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ dbQuery }));
vi.mock("@/lib/geo/nominatim", () => ({ cityFromCoords }));

import { findZone, listZones } from "@/lib/pricing/engine";
import { resolveRideZone, resolveRideZones, NoZoneError } from "@/lib/rides/city";

const bucharestEconomy = { id: "z1", city: "București", vehicle_class: "economy", max_passengers: 4 };

beforeEach(() => {
  dbQuery.mockReset();
  cityFromCoords.mockReset();
});

describe("findZone", () => {
  it("matches accent-insensitively and resolves suburb aliases (Otopeni → București)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [bucharestEconomy] });
    const z = await findZone("Otopeni", "ride", "economy");
    expect(z?.city).toBe("București");
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toContain("pricing_city_aliases");
    expect(sql).toContain("unaccent(lower(city))");
    expect(params).toEqual(["Otopeni", "RO", "ride", "economy"]);
  });

  it("lists only active zones for the canonical city", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [bucharestEconomy] });
    await listZones("Bucuresti", "ride");
    expect(dbQuery.mock.calls[0][0]).toContain("AND active");
  });
});

describe("ride city resolution", () => {
  it("returns the canonical zone (so dispatch searches the zone city's drivers)", async () => {
    cityFromCoords.mockResolvedValue("Voluntari");
    dbQuery.mockResolvedValueOnce({ rows: [bucharestEconomy] });
    const zone = await resolveRideZone({ lat: 44.49, lng: 26.18 }, "economy");
    expect(zone.city).toBe("București");
  });

  it("throws NoZoneError when there is no active zone", async () => {
    cityFromCoords.mockResolvedValue("Nowhere");
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolveRideZones({ lat: 1, lng: 1 })).rejects.toBeInstanceOf(NoZoneError);
  });

  it("throws NoZoneError when reverse geocoding fails", async () => {
    cityFromCoords.mockResolvedValue(null);
    await expect(resolveRideZone({ lat: 1, lng: 1 }, "economy")).rejects.toBeInstanceOf(NoZoneError);
  });
});
