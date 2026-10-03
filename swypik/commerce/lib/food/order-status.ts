/**
 * Mașina de stări a comenzilor Swypik Food (local_orders.status) — pură, testată.
 *
 * Cine poate muta comanda în starea X și din ce stări. Clientul poate anula
 * doar cât timp restaurantul nu a acceptat încă ('placed'); după aceea doar
 * restaurantul (cu motiv) sau adminul.
 *
 * Audit food-go #7: comenzile rămâneau blocate în ready / picked_up (nimeni
 * nu le putea anula). Adminul poate acum anula din orice stare nefinală și poate
 * marca livrarea; sistemul (watchdog) anulează comenzile placed neacceptate.
 */
export const ORDER_STATUSES = [
  "placed", "accepted", "preparing", "ready", "picked_up", "delivering", "delivered", "cancelled", "rejected",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type OrderActor = "customer" | "merchant" | "courier" | "admin" | "system";

type Rule = { from: readonly OrderStatus[]; actors: readonly OrderActor[] };

export const ORDER_TRANSITIONS: Readonly<Partial<Record<OrderStatus, Rule>>> = {
  accepted: { from: ["placed"], actors: ["merchant"] },
  rejected: { from: ["placed"], actors: ["merchant"] },
  preparing: { from: ["accepted"], actors: ["merchant"] },
  ready: { from: ["preparing", "accepted"], actors: ["merchant"] },
  picked_up: { from: ["ready"], actors: ["courier"] },
  delivering: { from: ["picked_up"], actors: ["courier"] },
  delivered: { from: ["delivering", "picked_up"], actors: ["courier", "admin"] },
  // Restaurantul: doar până la „ready” (poate exista deja un curier pe drum).
  // Adminul / sistemul: vezi CANCELLABLE_BY mai jos.
  cancelled: { from: ["placed", "accepted", "preparing"], actors: ["merchant"] },
};

/** Din ce stări poate anula fiecare actor (restaurantul: regula generală de mai sus). */
export const CANCELLABLE_BY: Readonly<Partial<Record<OrderActor, readonly OrderStatus[]>>> = {
  admin: ["placed", "accepted", "preparing", "ready", "picked_up", "delivering"],
  system: ["placed"],
};

/** Anularea de către client: doar înainte de confirmarea restaurantului. */
export const CUSTOMER_CANCELLABLE: readonly OrderStatus[] = ["placed"];

/** Stări finale — comanda nu se mai mișcă. */
export const FINAL_STATUSES: readonly OrderStatus[] = ["delivered", "cancelled", "rejected"];

/** Stări „active” pentru panoul restaurantului. */
export const ACTIVE_STATUSES: readonly OrderStatus[] = ["placed", "accepted", "preparing", "ready", "picked_up", "delivering"];

export type TransitionCheck =
  | { ok: true }
  | { ok: false; code: "unknown_status" | "forbidden_actor" | "invalid_transition" };

export function checkTransition(from: string, to: string, actor: OrderActor): TransitionCheck {
  if (to === "cancelled" && actor === "customer") {
    return CUSTOMER_CANCELLABLE.includes(from as OrderStatus)
      ? { ok: true }
      : { ok: false, code: "invalid_transition" };
  }
  if (to === "cancelled" && (actor === "admin" || actor === "system")) {
    return (CANCELLABLE_BY[actor] ?? []).includes(from as OrderStatus)
      ? { ok: true }
      : { ok: false, code: "invalid_transition" };
  }
  const rule = ORDER_TRANSITIONS[to as OrderStatus];
  if (!rule) return { ok: false, code: "unknown_status" };
  if (!rule.actors.includes(actor)) return { ok: false, code: "forbidden_actor" };
  if (!rule.from.includes(from as OrderStatus)) return { ok: false, code: "invalid_transition" };
  return { ok: true };
}

/** Actorul „natural” al unei tranziții (pentru a alege sesiunea în ruta de status). */
export function primaryActorFor(to: string): OrderActor | null {
  const rule = ORDER_TRANSITIONS[to as OrderStatus];
  return rule ? rule.actors[0] : null;
}

/** Coloana de timestamp setată la intrarea în stare. */
export const STATUS_TIMESTAMP_COL: Readonly<Partial<Record<OrderStatus, string>>> = {
  accepted: "accepted_at",
  ready: "ready_at",
  picked_up: "picked_up_at",
  delivered: "delivered_at",
  cancelled: "cancelled_at",
  rejected: "cancelled_at",
};

/** Următoarele acțiuni ale restaurantului, pentru panou. */
export function merchantNextActions(status: string): OrderStatus[] {
  return (Object.keys(ORDER_TRANSITIONS) as OrderStatus[]).filter((to) => {
    const r = ORDER_TRANSITIONS[to];
    return !!r && r.actors.includes("merchant") && r.from.includes(status as OrderStatus);
  });
}
