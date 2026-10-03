/** Opțiunile listei /food, partajate client/server (fără cod server). */
export const MERCHANT_KINDS = ["restaurant", "grocery", "pharmacy", "flowers", "other"] as const;
export const MERCHANT_SORTS = ["recommended", "distance", "fee", "time", "name"] as const;
export type MerchantSort = (typeof MERCHANT_SORTS)[number];
