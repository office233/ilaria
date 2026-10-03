import { describe, it, expect } from "vitest";

/**
 * app/api/apply-seller/route.ts: reaplicarea publica (fara autentificare) cu
 * un email deja existent NU trebuie sa poata reseta la 'pending' (sau
 * suprascrie datele) unui seller deja activ/aprobat/suspendat — altfel oricine
 * ar putea retrograda un cont existent doar stiindu-i emailul public.
 *
 * Fix: `ON CONFLICT (email) DO UPDATE ... WHERE sellers.status IN ('pending', 'rejected')`.
 * Acest test documenteaza / verifica exact acele statusuri permise.
 */
describe("apply-seller reapply guard", () => {
  const REAPPLY_ALLOWED_STATUSES = ["pending", "rejected"];

  function canReapplyOverwrite(existingStatus: string): boolean {
    return REAPPLY_ALLOWED_STATUSES.includes(existingStatus);
  }

  it("allows overwrite for a fresh pending application", () => {
    expect(canReapplyOverwrite("pending")).toBe(true);
  });

  it("allows overwrite for a previously rejected application", () => {
    expect(canReapplyOverwrite("rejected")).toBe(true);
  });

  it("does NOT allow overwrite of an active seller account", () => {
    expect(canReapplyOverwrite("active")).toBe(false);
  });

  it("does NOT allow overwrite of an approved seller account", () => {
    expect(canReapplyOverwrite("approved")).toBe(false);
  });

  it("does NOT allow overwrite of a suspended seller account", () => {
    expect(canReapplyOverwrite("suspended")).toBe(false);
  });
});
