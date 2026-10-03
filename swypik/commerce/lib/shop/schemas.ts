/**
 * Validarea intrărilor pentru rutele magazinului (cumpărător).
 * `passthrough` pe corpurile vechi: câmpurile moștenite din clienți mai vechi
 * (title, priceCents, products…) sunt IGNORATE, nu refuzate — prețul se
 * calculează mereu pe server.
 */
import { z } from "zod";
import { UUID_RE } from "@/lib/validation/uuid";

/** Același format ca restul aplicației (acceptă și id-uri non-v4 din seed-uri). */
const uuid = () => z.string().regex(UUID_RE);

export const ShopCheckoutSchema = z
  .object({
    /** Folosit doar dacă contul nu are email (ex. cont doar cu telefon). */
    email: z.string().trim().email().max(254).optional(),
    /**
     * "app" = WebView-ul aplicației mobile: plata folosește doar metode fără
     * redirect (card/3DS în iframe, wallet-uri native). O redirecționare la bancă
     * ar deschide browserul sistemului și return_url n-ar mai ajunge în aplicație.
     */
    client: z.enum(["web", "app"]).optional(),
  })
  .passthrough();

export const ShopCartAddSchema = z
  .object({
    productId: uuid(),
    variantId: uuid().nullish(),
    quantity: z.coerce.number().int().min(1).max(99).default(1),
    // Tolerant: un id de clip nevalid nu blochează adăugarea, doar nu se atribuie.
    videoId: z.string().max(64).nullish(),
  })
  .passthrough();

export const ShopReviewCreateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(200).nullish(),
  body: z.string().trim().max(4000).nullish(),
});

export const REVIEW_SORTS = ["recent", "helpful", "rating_high", "rating_low"] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

export const CATALOG_SORTS = ["newest", "price_asc", "price_desc", "popular", "rating"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export const CatalogQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(160).optional(),
  sort: z.enum(CATALOG_SORTS).default("newest"),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(48).optional(),
});
export type CatalogQuery = z.infer<typeof CatalogQuerySchema>;
