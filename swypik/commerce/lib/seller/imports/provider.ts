import type {
  CatalogPage,
  CatalogProvider,
  CustomerPage,
  ExternalCatalogProduct,
  ExternalCustomer,
  ExternalOrder,
  FetchCatalogPageArgs,
  OrderPage,
} from "./types";
import { CatalogProviderError } from "./common";
import {
  fetchShopifyCatalogPage,
  fetchShopifyCustomerPage,
  fetchShopifyCustomerById,
  fetchShopifyOrderPage,
  fetchShopifyOrderById,
  fetchShopifyProductById,
} from "./shopify";
import {
  fetchWooCommerceCatalogPage,
  fetchWooCommerceCustomerPage,
  fetchWooCommerceCustomerById,
  fetchWooCommerceOrderPage,
  fetchWooCommerceOrderById,
  fetchWooCommerceProductById,
} from "./woocommerce";

export async function fetchCatalogPage(
  provider: CatalogProvider,
  args: FetchCatalogPageArgs,
): Promise<CatalogPage> {
  switch (provider) {
    case "shopify":
      return fetchShopifyCatalogPage(args);
    case "woocommerce":
      return fetchWooCommerceCatalogPage(args);
    default:
      throw new CatalogProviderError("unsupported_catalog_provider", 400);
  }
}

export async function fetchCustomerPage(
  provider: CatalogProvider,
  args: FetchCatalogPageArgs,
): Promise<CustomerPage> {
  switch (provider) {
    case "shopify":
      return fetchShopifyCustomerPage(args);
    case "woocommerce":
      return fetchWooCommerceCustomerPage(args);
    default:
      throw new CatalogProviderError("unsupported_catalog_provider", 400);
  }
}

export async function fetchOrderPage(
  provider: CatalogProvider,
  args: FetchCatalogPageArgs,
): Promise<OrderPage> {
  switch (provider) {
    case "shopify":
      return fetchShopifyOrderPage(args);
    case "woocommerce":
      return fetchWooCommerceOrderPage(args);
    default:
      throw new CatalogProviderError("unsupported_catalog_provider", 400);
  }
}

export async function fetchProductById(
  provider: CatalogProvider,
  args: Omit<FetchCatalogPageArgs, "cursor" | "limit">,
  externalId: string,
): Promise<ExternalCatalogProduct | null> {
  switch (provider) {
    case "shopify":
      return fetchShopifyProductById(args, externalId);
    case "woocommerce":
      return fetchWooCommerceProductById(args, externalId);
    default:
      throw new CatalogProviderError("unsupported_catalog_provider", 400);
  }
}

export async function fetchCustomerById(
  provider: CatalogProvider,
  args: Omit<FetchCatalogPageArgs, "cursor" | "limit">,
  externalId: string,
): Promise<ExternalCustomer | null> {
  switch (provider) {
    case "shopify":
      return fetchShopifyCustomerById(args, externalId);
    case "woocommerce":
      return fetchWooCommerceCustomerById(args, externalId);
    default:
      throw new CatalogProviderError("unsupported_catalog_provider", 400);
  }
}

export async function fetchOrderById(
  provider: CatalogProvider,
  args: Omit<FetchCatalogPageArgs, "cursor" | "limit">,
  externalId: string,
): Promise<ExternalOrder | null> {
  switch (provider) {
    case "shopify":
      return fetchShopifyOrderById(args, externalId);
    case "woocommerce":
      return fetchWooCommerceOrderById(args, externalId);
    default:
      throw new CatalogProviderError("unsupported_catalog_provider", 400);
  }
}
