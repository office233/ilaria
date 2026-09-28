/**
 * Configurația magazinului (cumpărător). Nicio valoare de preț/limită nu e
 * scrisă în cod: totul vine din env, cu valori implicite conservatoare.
 *
 *  SHOP_SHIPPING_FLAT_CENTS            cost fix de livrare pe comandă (implicit 0)
 *  SHOP_FREE_SHIPPING_THRESHOLD_CENTS  subtotal de la care livrarea e gratuită (gol = niciodată)
 *  SHOP_MAX_LINE_QTY                   cantitatea maximă pe o linie de coș (implicit 10)
 *  SHOP_RESERVATION_MINUTES            cât timp o comandă neplătită ține stocul rezervat (implicit 30)
 *  SHOP_CURRENCY                       moneda catalogului (implicit RON)
 */

function intEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

export type ShopConfig = {
  shippingFlatCents: number;
  freeShippingThresholdCents: number | null;
  maxLineQty: number;
  reservationMinutes: number;
  currency: string;
};

export function getShopConfig(): ShopConfig {
  const threshold = process.env.SHOP_FREE_SHIPPING_THRESHOLD_CENTS;
  return {
    shippingFlatCents: intEnv("SHOP_SHIPPING_FLAT_CENTS", 0),
    freeShippingThresholdCents:
      threshold != null && threshold.trim() !== "" ? intEnv("SHOP_FREE_SHIPPING_THRESHOLD_CENTS", 0) : null,
    maxLineQty: intEnv("SHOP_MAX_LINE_QTY", 10, 1),
    reservationMinutes: intEnv("SHOP_RESERVATION_MINUTES", 30, 1),
    currency: (process.env.SHOP_CURRENCY || "RON").trim().toUpperCase().slice(0, 3) || "RON",
  };
}

/** Numărul de produse pe pagină în catalog (listări cu cursor). */
export const CATALOG_PAGE_SIZE = 24;
/** Numărul de recenzii încărcate pe pagină. */
export const REVIEWS_PAGE_SIZE = 10;
