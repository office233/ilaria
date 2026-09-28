/**
 * Resolver central de rută pe tip de produs.
 * Folosit de: ProductDrawer, ExploreClient (Buy Now), orice card de produs.
 *
 * Prioritate:
 *  1. `ctaUrl` (metadata.cta_url) — deep-link explicit setat pe produs (ex. /fly?dest=BCN)
 *  2. verticala (metadata.vertical sau taxonomy_node_slug) → pagina verticalei
 *  3. fallback: /product/<id> (produs clasic)
 */

export type RoutableProduct = {
    id: string | number;
    ctaUrl?: string | null;
    cta_url?: string | null;
    vertical?: string | null;
    taxonomyNodeSlug?: string | null;
    taxonomy_node_slug?: string | null;
    metadata?: Record<string, unknown> | null;
};

function isSafeInternalUrl(url: string): boolean {
    return url.startsWith("/") && !url.startsWith("//");
}

export function routeForProduct(product: RoutableProduct | null | undefined): string {
    if (!product?.id) return "/explore";
    const id = encodeURIComponent(String(product.id));

    const meta = (product.metadata || {}) as Record<string, unknown>;
    const ctaUrl = product.ctaUrl || product.cta_url || (meta["cta_url"] as string | undefined) || null;
    if (typeof ctaUrl === "string" && isSafeInternalUrl(ctaUrl.trim())) {
        return ctaUrl.trim();
    }

    const vertical = String(product.vertical || (meta["vertical"] as string | undefined) || "").toLowerCase();
    const slug = String(product.taxonomyNodeSlug || product.taxonomy_node_slug || "").toLowerCase();

    // Fly — nu există pagină de detaliu per-produs; fără cta_url mergem pe /fly (search).
    if (vertical === "fly" || vertical === "flights" || slug === "flights" || slug.startsWith("flights/")) {
        return "/fly";
    }
    // Stays — pagină de detaliu pe id.
    if (vertical === "stays" || slug === "vacation-rentals" || slug.startsWith("vacation-rentals/")) {
        return `/stays/${id}`;
    }
    // Food — comanda se face per-merchant; fără slug de merchant mergem pe /food.
    if (vertical === "food" || vertical === "eats" || slug === "food" || slug.startsWith("food/")) {
        const merchantSlug = meta["merchant_slug"] as string | undefined;
        return merchantSlug ? `/food/${encodeURIComponent(merchantSlug)}` : "/food";
    }
    // Go (rides) — cursele sunt entități proprii, nu produse; landing /go.
    if (vertical === "go" || vertical === "rides" || slug === "rides" || slug.startsWith("rides/")) {
        return "/go";
    }

    return `/product/${id}`;
}
