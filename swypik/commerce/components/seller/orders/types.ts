import type { SellerOrderAction, SellerOrderState, SellerOrderTab } from "@/lib/seller/fulfilment";

/** Rândul din GET /api/seller/orders (lib/seller/orders.ts → toView). */
export type SellerOrderRow = {
  order_id: string;
  order_status: string;
  state: SellerOrderState;
  status: string;
  actions: SellerOrderAction[];
  currency: string;
  created_at: string;
  total_cents: number;
  items: Array<{
    item_id: string;
    title: string;
    quantity: number;
    unit_amount_cents: number;
    source_status: string | null;
    metadata: { tracking_number?: string; carrier?: string } | null;
  }>;
  order_metadata: {
    tracking_number: string | null;
    tracking_url: string | null;
    tracking_carrier: string | null;
    shipping_method: string | null;
    shipping_address: Record<string, string | undefined> | null;
    customer_name: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    easybox_locker: string | null;
    awb_details: { awb_number?: string; carrier?: string } | null;
    return_reason: string | null;
    return_requested_at: string | null;
  };
};

export type OrderCounts = Record<SellerOrderTab, number>;

/** Codurile de eroare cu text propriu (sellerPanel.orders.errors.*). */
export const ORDER_ERRORS = [
  "invalid_transition",
  "missing_payment_intent",
  "stripe_refund_failed",
  "awb_number_required",
  "invalid_status",
  "not_found",
  "rate_limited",
  "multi_seller_requires_admin",
] as const;
