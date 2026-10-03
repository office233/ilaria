/**
 * The single list of active News categories (client-safe). The ingester,
 * the AI journalist schema, the API filter and the UI tabs all read it.
 * Labels: `news.categories.<slug>` in messages.
 */
export const NEWS_CATEGORY_SLUGS = ["tech-ai", "gaming", "business", "science"] as const;
export type NewsCategorySlug = (typeof NEWS_CATEGORY_SLUGS)[number];

export const NEWS_CATEGORY_FILTERS = ["all", ...NEWS_CATEGORY_SLUGS] as const;
export type NewsCategoryFilter = (typeof NEWS_CATEGORY_FILTERS)[number];

export function isNewsCategory(value: unknown): value is NewsCategorySlug {
  return typeof value === "string" && (NEWS_CATEGORY_SLUGS as readonly string[]).includes(value);
}

/** Normalizes a ?category= value: unknown → null (= all). */
export function parseCategoryFilter(value: string | null | undefined): NewsCategorySlug | null {
  return isNewsCategory(value) ? value : null;
}
