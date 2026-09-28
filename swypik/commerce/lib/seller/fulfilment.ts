/**
 * Ciclul de viață al unei comenzi, văzut de un seller (doar item-urile lui).
 * Pur — fără DB — ca să fie testat exhaustiv și folosit și în UI.
 *
 *   awaiting_payment ─(webhook)→ new ─accept→ accepted ─ship→ shipped ─deliver→ delivered
 *                                  │  └──────────ship──────────↑
 *                                  └─cancel─┬─ (și din accepted) → cancelled (+ refund)
 *   return_requested ─refund_return→ refunded   (doar cu FEATURE_RETURNS)
 */

export const SELLER_ORDER_STATES = [
  "awaiting_payment",
  "new",
  "accepted",
  "shipped",
  "delivered",
  "return_requested",
  "cancelled",
  "refunded",
] as const;
export type SellerOrderState = (typeof SELLER_ORDER_STATES)[number];

export const SELLER_ORDER_ACTIONS = ["accept", "ship", "deliver", "cancel", "refund_return"] as const;
export type SellerOrderAction = (typeof SELLER_ORDER_ACTIONS)[number];

export type FulfilmentItem = {
  source_status: string | null;
  metadata?: { seller_accepted_at?: string | null; delivered_at?: string | null } | null;
};

const TRANSITIONS: Record<SellerOrderState, Partial<Record<SellerOrderAction, SellerOrderState>>> = {
  awaiting_payment: {},
  new: { accept: "accepted", ship: "shipped", cancel: "cancelled" },
  accepted: { ship: "shipped", cancel: "cancelled" },
  shipped: { deliver: "delivered" },
  delivered: {},
  return_requested: { refund_return: "refunded" },
  cancelled: {},
  refunded: {},
};

const UNPAID = new Set(["pending", "authorized", "failed"]);

/** Starea felii seller-ului dintr-o comandă. */
export function deriveSellerOrderState(orderStatus: string, items: FulfilmentItem[]): SellerOrderState {
  if (orderStatus === "refunded") return "refunded";
  if (orderStatus === "return_requested") return "return_requested";
  if (orderStatus === "cancelled") return "cancelled";
  if (UNPAID.has(orderStatus)) return "awaiting_payment";
  const live = items.filter((i) => i.source_status !== "cancelled");
  if (items.length > 0 && live.length === 0) return "cancelled";
  if (live.length === 0) return "new";
  if (live.every((i) => i.source_status === "fulfilled")) {
    return orderStatus === "delivered" || live.every((i) => Boolean(i.metadata?.delivered_at)) ? "delivered" : "shipped";
  }
  return live.some((i) => Boolean(i.metadata?.seller_accepted_at)) ? "accepted" : "new";
}

export type TransitionResult = { ok: true; next: SellerOrderState } | { ok: false; code: "invalid_transition" };

export function nextSellerOrderState(state: SellerOrderState, action: SellerOrderAction): TransitionResult {
  const next = TRANSITIONS[state][action];
  return next ? { ok: true, next } : { ok: false, code: "invalid_transition" };
}

/** Acțiunile afișabile în UI pentru o stare (refund_return doar dacă retururile sunt pornite). */
export function allowedSellerActions(state: SellerOrderState, opts: { returnsEnabled: boolean }): SellerOrderAction[] {
  return (Object.keys(TRANSITIONS[state]) as SellerOrderAction[]).filter(
    (a) => a !== "refund_return" || opts.returnsEnabled,
  );
}

export function isSellerOrderAction(v: unknown): v is SellerOrderAction {
  return typeof v === "string" && (SELLER_ORDER_ACTIONS as readonly string[]).includes(v);
}

/** Tab-urile din lista de comenzi → stările incluse. */
export const SELLER_ORDER_TABS = {
  todo: ["new", "accepted"],
  shipped: ["shipped"],
  done: ["delivered"],
  issues: ["return_requested", "cancelled", "refunded"],
} as const satisfies Record<string, readonly SellerOrderState[]>;
export type SellerOrderTab = keyof typeof SELLER_ORDER_TABS | "all";
