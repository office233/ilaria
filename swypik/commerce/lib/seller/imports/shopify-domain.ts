import { CatalogProviderError } from "./common";

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function normalizeShopifyStore(raw: string): string {
  const value = raw.trim().toLowerCase();
  let host: string;
  try {
    host = new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    throw new CatalogProviderError("invalid_shopify_store", 400);
  }
  if (!SHOP_DOMAIN.test(host)) {
    throw new CatalogProviderError("invalid_shopify_store", 400);
  }
  return host;
}
