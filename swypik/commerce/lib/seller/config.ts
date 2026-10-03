/**
 * Configurația panoului de seller — nicio sumă/limită scrisă în cod.
 *
 *  SELLER_PAYOUT_MIN_CENTS  pragul minim al unei retrageri (fallback PAYOUT_MIN_CENTS, implicit 5000)
 *  RETURN_WINDOW_DAYS       zilele după expediere până când banii devin retrăgibili (implicit 14,
 *                           aceeași variabilă ca în cron/process-payouts)
 *  PLATFORM_COMMISSION_BPS  comisionul platformei (lib/config/commerce)
 *  SHOP_CURRENCY            moneda catalogului (lib/shop/config)
 */
import { PLATFORM_COMMISSION_BPS } from "@/lib/config/commerce";
import { intEnv } from "@/lib/config/env";
import { getShopConfig } from "@/lib/shop/config";

export function sellerPayoutMinCents(): number {
  const primary = process.env.SELLER_PAYOUT_MIN_CENTS;
  if (primary != null && primary.trim() !== "") {
    return intEnv("SELLER_PAYOUT_MIN_CENTS", 5_000, 1);
  }
  return intEnv("PAYOUT_MIN_CENTS", 5_000, 1);
}

export function sellerReturnWindowDays(): number {
  return intEnv("RETURN_WINDOW_DAYS", 14, 1);
}

export function sellerCurrency(): string {
  return getShopConfig().currency;
}

export function sellerCommissionBps(): number {
  return PLATFORM_COMMISSION_BPS;
}

/** Pagina de comenzi — câte comenzi se încarcă o dată. */
export const SELLER_ORDERS_PAGE_SIZE = 20;
/** Imagini maxime per produs (aceeași limită ca schema de creare). */
export const SELLER_PRODUCT_MAX_IMAGES = 8;
/** Variante maxime per produs. */
export const SELLER_PRODUCT_MAX_VARIANTS = 50;
