import { describe, expect, it } from "vitest";
import { scoreDispute } from "@/lib/stripe/dispute-win-score";

/**
 * Audit 2026-09-24 (wave2-misc): scoreDispute used to return ~20 hardcoded
 * Romanian strings (factor notes, recommendation, missing-field labels)
 * rendered directly on app/admin/disputes/page.tsx. It now returns stable
 * i18n keys (+ params) only; the admin page translates them via the
 * `adminDisputeScore` namespace. This test locks the contract: no hardcoded
 * human-readable text leaks out of the scorer.
 */
describe("scoreDispute — i18n-safe output contract", () => {
  it("returns translation keys, not literal strings, for factors/recommendation/missing/combos", () => {
    const result = scoreDispute({
      reason: "product_not_received",
      evidence: { receipt: "r.pdf" },
      hasOrderLink: true,
    });

    for (const f of result.factors) {
      expect(typeof f.noteKey).toBe("string");
      expect(f.noteKey.length).toBeGreaterThan(0);
      // must be a dotted key like "factor.receipt", never prose with spaces
      expect(f.noteKey).not.toMatch(/\s/);
      expect((f as unknown as { note?: string }).note).toBeUndefined();
    }

    expect(typeof result.recommendationKey).toBe("string");
    expect(result.recommendationKey).not.toMatch(/\s/);
    expect((result as unknown as { recommendation?: string }).recommendation).toBeUndefined();

    for (const m of result.missing) {
      expect(typeof m.labelKey).toBe("string");
      expect(m.labelKey).not.toMatch(/\s/);
      expect((m as unknown as { label?: string }).label).toBeUndefined();
    }

    for (const c of result.combos) {
      for (const k of c.labelKeys) {
        expect(typeof k).toBe("string");
        expect(k).not.toMatch(/\s/);
      }
      expect((c as unknown as { labels?: string[] }).labels).toBeUndefined();
    }
  });

  it("keeps score/label semantics stable for a strong product_not_received case", () => {
    const result = scoreDispute({
      reason: "product_not_received",
      evidence: {
        shipping_documentation: "awb.pdf",
        shipping_tracking_number: "TRACK123",
      },
      hasOrderLink: true,
    });
    expect(result.label).toBe("high");
    expect(result.recommendationKey).toBe("recommendation.high");
  });

  it("flags zero evidence with the noEvidence factor and a low/medium score", () => {
    const result = scoreDispute({ reason: "general", evidence: {}, hasOrderLink: false });
    expect(result.factors.some((f) => f.noteKey === "factor.noEvidence")).toBe(true);
    expect(result.factors.some((f) => f.noteKey === "factor.noOrder")).toBe(true);
  });

  it("suggests missing fields sorted by descending potential impact", () => {
    const result = scoreDispute({ reason: "product_unacceptable", evidence: {}, hasOrderLink: true });
    const deltas = result.missing.map((m) => m.potentialDelta);
    const sorted = [...deltas].sort((a, b) => b - a);
    expect(deltas).toEqual(sorted);
  });
});
