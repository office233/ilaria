"use client";

import { useTranslations } from "next-intl";

/** Codurile de eroare întoarse de rutele magazinului (vezi lib/shop/*, app/api/cart, checkout, reviews). */
const KNOWN_CODES = new Set([
  "auth_required",
  "rate_limited",
  "validation_error",
  "account_blocked",
  "cart_empty",
  "email_required",
  "invalid_quantity",
  "product_unavailable",
  "not_purchasable",
  "variant_required",
  "variant_unavailable",
  "insufficient_stock",
  "mixed_currency",
  "payments_unavailable",
  "checkout_failed",
  "product_not_found",
  "cart_add_failed",
  "already_reviewed",
  "not_verified_buyer",
  "network",
  "payment_in_progress",
]);

/** Transformă `{ code }` dintr-un răspuns API în mesaj tradus. */
export function useShopError() {
  const t = useTranslations("shopBuyer.errors");
  return (payload: unknown): string => {
    const code =
      payload && typeof payload === "object" && typeof (payload as { code?: unknown }).code === "string"
        ? (payload as { code: string }).code
        : null;
    return code && KNOWN_CODES.has(code) ? t(code) : t("generic");
  };
}
