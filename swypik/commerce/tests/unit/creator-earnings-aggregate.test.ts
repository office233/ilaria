import { describe, it, expect, vi } from "vitest";

/**
 * Câștigurile creatorilor/artiștilor trebuie calculate DOAR din deblocările
 * plătite cu cardul (Stripe): `payment_intent_id IS NOT NULL AND status = 'paid'`.
 * Deblocările legacy din era SWYP nu mai intră în suma de bani, dar pot
 * continua să conteze la statisticile de "număr de deblocări".
 */

let lastSql = "";
let lastParams: unknown[] = [];
let mockRows: Array<Record<string, string>> = [];

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    lastSql = sql;
    lastParams = params;
    return { rows: mockRows, rowCount: mockRows.length };
  }),
  withTransaction: vi.fn(),
}));

import { creatorShareTotals } from "@/lib/movies/repository";
import { artistEarnings } from "@/lib/music/repository";

describe("creator/artist earnings — agregat doar pe deblocări plătite cu cardul", () => {
  it("creatorShareTotals filtrează pe payment_intent_id IS NOT NULL AND status = 'paid' pentru sumă", async () => {
    mockRows = [{ total_units: "1050", unlocks: "12" }];
    const r = await creatorShareTotals("owner-1");
    expect(lastSql).toMatch(/payment_intent_id IS NOT NULL AND u\.status = 'paid'/);
    expect(lastSql).toMatch(/FILTER \(WHERE u\.status = 'paid'\)/);
    expect(lastParams).toEqual(["owner-1"]);
    expect(r).toEqual({ total_units: 1050, unlocks: 12 });
  });

  it("creatorShareTotals: fără rânduri → 0/0", async () => {
    mockRows = [];
    const r = await creatorShareTotals("owner-2");
    expect(r).toEqual({ total_units: 0, unlocks: 0 });
  });

  it("artistEarnings filtrează pe payment_intent_id IS NOT NULL AND status = 'paid' pentru sumă și nu mai include tips", async () => {
    mockRows = [{ unlock_units: "700", unlocks_count: "5" }];
    const r = await artistEarnings("artist-1");
    expect(lastSql).not.toMatch(/music_tips/);
    expect(lastSql).toMatch(/payment_intent_id IS NOT NULL AND u\.status = 'paid'/);
    expect(lastParams).toEqual(["artist-1"]);
    expect(r).toEqual({ unlock_units: 700, unlocks_count: 5 });
  });
});
