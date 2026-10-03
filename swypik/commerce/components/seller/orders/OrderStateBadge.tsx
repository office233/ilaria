"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import type { SellerOrderState } from "@/lib/seller/fulfilment";

const TONE: Record<SellerOrderState, "neutral" | "success" | "warning" | "danger" | "info" | "brand"> = {
  awaiting_payment: "neutral",
  new: "warning",
  accepted: "brand",
  shipped: "info",
  delivered: "success",
  return_requested: "warning",
  cancelled: "neutral",
  refunded: "danger",
};

export function OrderStateBadge({ state }: { state: SellerOrderState }) {
  const t = useTranslations("sellerPanel.orders.state");
  return <Badge tone={TONE[state] ?? "neutral"}>{t(state)}</Badge>;
}
