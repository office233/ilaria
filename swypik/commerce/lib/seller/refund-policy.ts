export type SellerRefundPolicyInput = {
  orderStatus: string;
  totalItems: number;
  sellerItems: number;
  paymentIntentId?: string | null;
  existingRefundId?: string | null;
};

export type SellerRefundPolicyResult =
  | { allowed: true; code: "ok"; message: string }
  | { allowed: false; code: string; message: string };

export function evaluateSellerRefundRequest(input: SellerRefundPolicyInput): SellerRefundPolicyResult {
  if (input.orderStatus === "refunded" || input.existingRefundId) {
    return {
      allowed: false,
      code: "already_refunded",
      message: "Comanda a fost deja rambursata.",
    };
  }

  if (input.orderStatus !== "return_requested") {
    return {
      allowed: false,
      code: "invalid_status",
      message: `Returul nu poate fi aprobat pentru statusul "${input.orderStatus}".`,
    };
  }

  if (input.sellerItems < 1) {
    return {
      allowed: false,
      code: "order_not_owned",
      message: "Comanda nu a fost gasita sau nu apartine sellerului.",
    };
  }

  if (input.totalItems !== input.sellerItems) {
    return {
      allowed: false,
      code: "multi_seller_requires_admin",
      message: "Comenzile cu produse de la mai multi selleri necesita refund administrativ.",
    };
  }

  if (!input.paymentIntentId) {
    return {
      allowed: false,
      code: "missing_payment_intent",
      message: "Nu s-a gasit Payment Intent-ul Stripe pentru aceasta comanda.",
    };
  }

  return {
    allowed: true,
    code: "ok",
    message: "Refundul poate fi procesat.",
  };
}
