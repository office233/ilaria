/** Ieșirea structurată a asistentului de shopping (Azure OpenAI json_schema strict). */
import { z } from "zod";

export const CHAT_INTENTS = [
  "search_product",
  "explain_product",
  "compare_products",
  "find_cheaper",
  "refine_search",
  "add_to_cart",
  "checkout",
  "track_order",
  "general_chat",
] as const;

export const CHAT_SORTS = ["recommended", "price_asc", "price_desc", "popular", "delivery", "discount"] as const;

export const OrchestratorOutputSchema = z.object({
  intent: z.enum(CHAT_INTENTS),
  reply: z.string(),
  searchQuery: z.string().optional(),
  category: z.string().optional(),
  bundleQueries: z.array(z.string()).optional(),
  productId: z.string().optional(),
  productTitle: z.string().optional(),
  maxPrice: z.number().optional(),
  sort: z.enum(CHAT_SORTS).optional(),
  shouldAskFollowUp: z.boolean().optional(),
});
