/**
 * Categoriile magazinului pentru paginile publice: arborele vine din
 * `getCategoryHierarchy` (taxonomie, cu rezervă pe coloanele vechi), aici doar
 * tipizăm și căutăm drumul unui slug.
 */
import { CATALOG_SORTS, type CatalogSort } from "./schemas";

export type CategoryNode = { id: string; name: string; count?: number; children?: CategoryNode[] };

export async function getShopCategories(locale: string): Promise<CategoryNode[]> {
  const { getCategoryHierarchy } = await import("@/lib/db/product-queries");
  const tree = (await getCategoryHierarchy(locale)) as CategoryNode[];
  return Array.isArray(tree) ? tree : [];
}

/** Drumul de la rădăcină până la nodul cu `slug` (inclusiv), sau null. */
export function findCategoryPath(tree: CategoryNode[], slug: string, trail: CategoryNode[] = []): CategoryNode[] | null {
  for (const node of tree) {
    const path = [...trail, node];
    if (node.id === slug) return path;
    if (node.children?.length) {
      const found = findCategoryPath(node.children, slug, path);
      if (found) return found;
    }
  }
  return null;
}

/** Slug-ul din URL poate veni codat (`department%3Aother`). */
export function decodeCategorySlug(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function parseCatalogSort(raw: string | string[] | undefined): CatalogSort {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (CATALOG_SORTS as readonly string[]).includes(v ?? "") ? (v as CatalogSort) : "newest";
}

export function firstParam(raw: string | string[] | undefined): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = v?.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
}
