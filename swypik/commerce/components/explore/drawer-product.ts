import type { ProductData } from "@/components/ProductDrawer";
import type { FeedVideoProduct } from "@/lib/feed/types";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Eticheta de livrare, tradusă (serverul trimite doar shippingCents). */
export function deliveryLabel(p: FeedVideoProduct, t: Translate, formatPrice: (cents: number) => string): string | null {
  if (p.vertical) return null; // zboruri/cazări — nu se livrează
  if (p.shippingCents === 0) return t("deliveryIncluded");
  if (p.shippingCents != null && p.shippingCents > 0) return t("deliveryCost", { price: formatPrice(p.shippingCents) });
  return t("deliveryAtCheckout");
}

/** Produsul din feed în forma așteptată de ProductDrawer. */
export function toDrawerProduct(p: FeedVideoProduct, t: Translate, formatPrice: (cents: number) => string): ProductData & {
  ctaUrl: string | null;
  vertical: string | null;
  taxonomyNodeSlug: string | null;
} {
  return {
    id: p.id,
    name: p.name,
    title: p.title,
    image: p.image,
    image_url: p.image_url,
    priceCents: p.priceCents,
    price: p.price,
    currency: p.currency,
    inventoryStatus: p.inventoryStatus,
    deliveryLabel: deliveryLabel(p, t, formatPrice),
    votes: {
      ...p.votes,
      viewerVote: p.votes.viewerVote === "worth_it" || p.votes.viewerVote === "not_worth_it" ? p.votes.viewerVote : null,
    },
    ctaUrl: p.ctaUrl,
    vertical: p.vertical,
    taxonomyNodeSlug: p.taxonomyNodeSlug,
  };
}
