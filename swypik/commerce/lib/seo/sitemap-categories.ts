import type { CategoryNode } from "@/lib/shop/categories";

/** Plafon: un sitemap are max 50k URL-uri; categoriile reale sunt câteva sute. */
const MAX_CATEGORY_URLS = 2000;

/**
 * Slug-urile de categorie vin din ACELAȘI arbore pe care îl folosește pagina
 * /categories/[slug] (getShopCategories → findCategoryPath), deci fiecare URL
 * emis se rezolvă (fără 404-urile listei hardcodate de dinainte).
 */
export function flattenCategoryIds(tree: CategoryNode[], out: string[] = []): string[] {
  for (const node of tree) {
    if (out.length >= MAX_CATEGORY_URLS) break;
    if (node.id && !out.includes(node.id)) out.push(node.id);
    if (node.children?.length) flattenCategoryIds(node.children, out);
  }
  return out;
}
