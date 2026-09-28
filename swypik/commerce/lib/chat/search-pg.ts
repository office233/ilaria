/**
 * PostgreSQL search wrapper for chat context
 * Encapsulates the search + unique + bundle logic used by /api/chat
 */

import { searchProducts, type ProductFilters } from "@/lib/db/product-queries";
import { inferBundleQueries, buildSalesSuggestion } from "@/lib/sales/bundle-engine";
import { detectCategory } from "./category-detect";

type ProductModel = any;

/** Locale-uri suportate pentru mesajele de fallback. Default `"ro"` — păstrează
 * comportamentul istoric pentru `/api/chat`, care încă nu trece locale-ul cererii. */
export type ChatFallbackLocale = "ro" | "en" | "es" | "fr" | "de" | "pt" | "it";

const NO_CATEGORY_RESULTS_FOUND_ELSEWHERE: Record<ChatFallbackLocale, (category: string) => string> = {
  ro: (c) => `⚠️ Nu avem încă produse în categoria "${c}", dar îți arăt ce am găsit relevant:\n\n`,
  en: (c) => `⚠️ We don't have products in the "${c}" category yet, but here's what else looks relevant:\n\n`,
  es: (c) => `⚠️ Todavía no tenemos productos en la categoría "${c}", pero esto es lo que encontramos relevante:\n\n`,
  fr: (c) => `⚠️ Nous n'avons pas encore de produits dans la catégorie « ${c} », mais voici ce que nous avons trouvé de pertinent :\n\n`,
  de: (c) => `⚠️ Wir haben noch keine Produkte in der Kategorie „${c}", aber hier ist, was wir sonst Relevantes gefunden haben:\n\n`,
  pt: (c) => `⚠️ Ainda não temos produtos na categoria "${c}", mas aqui está o que encontrámos relevante:\n\n`,
  it: (c) => `⚠️ Non abbiamo ancora prodotti nella categoria "${c}", ma ecco cosa abbiamo trovato di rilevante:\n\n`,
};

const NO_CATEGORY_RESULTS_AT_ALL: Record<ChatFallbackLocale, (category: string) => string> = {
  ro: (c) => `⚠️ Momentan nu avem produse în categoria „${c}". Adăugăm noi produse zilnic! Între timp, poți căuta în categoriile disponibile (rochii, haine femei, accesorii).\n\n`,
  en: (c) => `⚠️ We don't currently have products in the "${c}" category. We add new products daily! Meanwhile, try one of the available categories (dresses, women's clothing, accessories).\n\n`,
  es: (c) => `⚠️ Actualmente no tenemos productos en la categoría "${c}". ¡Añadimos productos nuevos cada día! Mientras tanto, prueba con alguna de las categorías disponibles (vestidos, ropa de mujer, accesorios).\n\n`,
  fr: (c) => `⚠️ Nous n'avons actuellement pas de produits dans la catégorie « ${c} ». Nous ajoutons de nouveaux produits chaque jour ! En attendant, essayez l'une des catégories disponibles (robes, vêtements femme, accessoires).\n\n`,
  de: (c) => `⚠️ Wir haben derzeit keine Produkte in der Kategorie „${c}". Wir fügen täglich neue Produkte hinzu! Probiere in der Zwischenzeit eine der verfügbaren Kategorien (Kleider, Damenbekleidung, Accessoires).\n\n`,
  pt: (c) => `⚠️ Atualmente não temos produtos na categoria "${c}". Adicionamos produtos novos todos os dias! Entretanto, experimenta uma das categorias disponíveis (vestidos, roupa de senhora, acessórios).\n\n`,
  it: (c) => `⚠️ Al momento non abbiamo prodotti nella categoria "${c}". Aggiungiamo nuovi prodotti ogni giorno! Nel frattempo, prova una delle categorie disponibili (abiti, abbigliamento donna, accessori).\n\n`,
};

export async function searchPG(
  query: string,
  limit = 16,
  opts: { maxPrice?: number; category?: string; sort?: string; excludeIds?: string[] } = {},
): Promise<ProductModel[]> {
  const filters: ProductFilters = {
    search: query || undefined,
    category: opts.category || detectCategory(query),
    maxPrice: opts.maxPrice,
    sort: (opts.sort as ProductFilters["sort"]) || "popular",
    limit,
    offset: 0,
    excludeIds: opts.excludeIds,
  };

  const result = await searchProducts(filters);
  return result.products;
}

export function uniqueProducts(products: ProductModel[]) {
  return products.filter(
    (p: any, idx: number, arr: any[]) => arr.findIndex((x: any) => x.id === p.id) === idx,
  );
}

/**
 * Search with progressive fallback:
 * 1. Query + category + maxPrice
 * 2. Category only (no query)
 * 3. Drop maxPrice
 * 4. Drop category
 */
export async function searchWithFallback(
  query: string,
  opts: {
    maxPrice?: number;
    category?: string;
    sort?: string;
    excludeIds?: string[];
    userMessage?: string;
  },
  locale: ChatFallbackLocale = "ro",
): Promise<{ products: ProductModel[]; replyPrefix: string }> {
  const { maxPrice, category, sort, excludeIds } = opts;
  let replyPrefix = "";

  let products = await searchPG(query, 16, { maxPrice, category, sort, excludeIds });

  // Fallback 1: if excludeIds exhausted results
  if (products.length === 0 && excludeIds && excludeIds.length > 0 && category) {
    products = await searchPG("", 16, { maxPrice, category, sort, excludeIds });
  }
  // Fallback 2: drop maxPrice
  if (products.length === 0 && maxPrice) {
    products = await searchPG("", 16, { category, sort, excludeIds });
  }
  // Fallback 3: drop category, search globally
  if (products.length === 0 && category) {
    products = await searchPG(query, 16, { maxPrice, sort });
    if (products.length > 0) {
      replyPrefix = NO_CATEGORY_RESULTS_FOUND_ELSEWHERE[locale](category);
    }
  }
  // Still nothing
  if (products.length === 0 && category) {
    replyPrefix = NO_CATEGORY_RESULTS_AT_ALL[locale](category);
  }

  return { products, replyPrefix };
}

/**
 * Fetch bundle (complementary) products for a set of main products
 */
export async function fetchBundles(
  products: ProductModel[],
  query: string,
  aiQueries: string[],
  opts: { maxPrice?: number; category?: string } = {},
): Promise<ProductModel[]> {
  if (products.length === 0) return [];

  const bundleQueries = [...aiQueries, ...inferBundleQueries(query)];
  const bundleCategory = products.length > 0 ? opts.category : undefined;

  const bundleResults = await Promise.all(
    bundleQueries.slice(0, 2).map((bq) => searchPG(bq, 6, { maxPrice: opts.maxPrice, category: bundleCategory })),
  );

  return uniqueProducts(bundleResults.flat())
    .filter((p) => !products.some((main: any) => main.id === p.id))
    .slice(0, 12);
}

/**
 * Build a bundle suggestion string
 */
export function buildBundleSuggestionText(products: ProductModel[], bundleProducts: ProductModel[]): string {
  if (!products[0]) return "";
  return `\n\n${buildSalesSuggestion(products[0], bundleProducts.slice(0, 2))}`;
}
