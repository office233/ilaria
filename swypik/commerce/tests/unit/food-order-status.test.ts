import { describe, it, expect } from "vitest";
import { checkTransition, merchantNextActions, primaryActorFor, CUSTOMER_CANCELLABLE } from "@/lib/food/order-status";

/** w2-food: mașina de stări a comenzilor Food (pură). */
describe("checkTransition", () => {
  it("lets the merchant accept/reject only a placed order", () => {
    expect(checkTransition("placed", "accepted", "merchant")).toEqual({ ok: true });
    expect(checkTransition("placed", "rejected", "merchant")).toEqual({ ok: true });
    expect(checkTransition("accepted", "rejected", "merchant")).toEqual({ ok: false, code: "invalid_transition" });
    expect(checkTransition("preparing", "accepted", "merchant")).toEqual({ ok: false, code: "invalid_transition" });
  });

  it("walks the happy path merchant → courier", () => {
    const path: [string, string, "merchant" | "courier"][] = [
      ["placed", "accepted", "merchant"],
      ["accepted", "preparing", "merchant"],
      ["preparing", "ready", "merchant"],
      ["ready", "picked_up", "courier"],
      ["picked_up", "delivering", "courier"],
      ["delivering", "delivered", "courier"],
    ];
    for (const [from, to, actor] of path) expect(checkTransition(from, to, actor).ok).toBe(true);
  });

  it("does not let the courier deliver before pickup (ready → delivered)", () => {
    expect(checkTransition("ready", "delivered", "courier")).toEqual({ ok: false, code: "invalid_transition" });
  });

  it("rejects the wrong actor", () => {
    expect(checkTransition("placed", "accepted", "courier")).toEqual({ ok: false, code: "forbidden_actor" });
    expect(checkTransition("ready", "picked_up", "merchant")).toEqual({ ok: false, code: "forbidden_actor" });
  });

  it("lets the customer cancel only before the restaurant confirms", () => {
    expect(CUSTOMER_CANCELLABLE).toEqual(["placed"]);
    expect(checkTransition("placed", "cancelled", "customer")).toEqual({ ok: true });
    expect(checkTransition("accepted", "cancelled", "customer")).toEqual({ ok: false, code: "invalid_transition" });
    expect(checkTransition("placed", "accepted", "customer")).toEqual({ ok: false, code: "forbidden_actor" });
  });

  it("lets the merchant cancel until preparing but not once ready or final", () => {
    for (const s of ["placed", "accepted", "preparing"]) expect(checkTransition(s, "cancelled", "merchant").ok).toBe(true);
    for (const s of ["ready", "picked_up", "delivered", "cancelled", "rejected"]) {
      expect(checkTransition(s, "cancelled", "merchant").ok).toBe(false);
    }
  });

  it("rejects unknown target statuses", () => {
    expect(checkTransition("placed", "teleported", "merchant")).toEqual({ ok: false, code: "unknown_status" });
  });
});

describe("merchantNextActions / primaryActorFor", () => {
  it("lists the panel buttons per status", () => {
    expect(merchantNextActions("placed").sort()).toEqual(["accepted", "cancelled", "rejected"]);
    expect(merchantNextActions("accepted").sort()).toEqual(["cancelled", "preparing", "ready"]);
    expect(merchantNextActions("ready")).toEqual([]);
    expect(merchantNextActions("delivered")).toEqual([]);
  });

  it("maps a target status to the session that must perform it", () => {
    expect(primaryActorFor("accepted")).toBe("merchant");
    expect(primaryActorFor("cancelled")).toBe("merchant");
    expect(primaryActorFor("picked_up")).toBe("courier");
    expect(primaryActorFor("nope")).toBeNull();
  });
});
