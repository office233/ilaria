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
import { getShopConfig } from "@/lib/shop/config";

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

export function sellerPayoutMinCents(): number {
  return positiveInt(process.env.SELLER_PAYOUT_MIN_CENTS ?? process.env.PAYOUT_MIN_CENTS, 5_000);
}

export function sellerReturnWindowDays(): number {
  return positiveInt(process.env.RETURN_WINDOW_DAYS, 14);
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
