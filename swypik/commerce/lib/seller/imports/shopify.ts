import { intEnv } from "@/lib/config/env";
import { safeFetch } from "@/lib/security/ssrf";
import { normalizeShopifyStore } from "./shopify-domain";
import { ensureFreshShopifyCredentials } from "./shopify-oauth";
import type {
  CatalogPage,
  CustomerPage,
  ExternalCatalogProduct,
  ExternalCustomer,
  ExternalOrder,
  FetchCatalogPageArgs,
  OrderPage,
  ShopifyCredentials,
} from "./types";
import {
  boundedImages,
  boundedText,
  CatalogProviderError,
  moneyToCents,
  normalizeCurrency,
  plainText,
  positiveStock,
} from "./common";

type ShopifyVariant = {
  id: string;
  title?: string | null;
  sku?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  inventoryQuantity?: number | null;
  inventoryPolicy?: string | null;
  inventoryItem?: { tracked?: boolean | null } | null;
  selectedOptions?: Array<{ name?: string | null; value?: string | null }>;
};

type ShopifyProduct = {
  id: string;
  title?: string | null;
  description?: string | null;
  vendor?: string | null;
  productType?: string | null;
  status?: string | null;
  handle?: string | null;
  totalInventory?: number | null;
  onlineStoreUrl?: string | null;
  media?: { nodes?: Array<{ image?: { url?: string | null } | null }> };
  variants?: {
    nodes?: ShopifyVariant[];
    pageInfo?: { hasNextPage?: boolean };
  };
};

type ShopifyCustomer = {
  id?: string;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  defaultAddress?: {
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    country?: string | null;
    zip?: string | null;
  } | null;
};

type ShopifyResponse = {
  data?: {
    shop?: { currencyCode?: string | null };
    products?: {
      nodes?: ShopifyProduct[];
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
  errors?: Array<{ message?: string }>;
};

type ShopifyMoneyBag = {
  shopMoney?: { amount?: string | null; currencyCode?: string | null } | null;
};

type ShopifyOrder = {
  id?: string;
  name?: string | null;
  createdAt?: string | null;
  cancelledAt?: string | null;
  currencyCode?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  currentSubtotalPriceSet?: ShopifyMoneyBag | null;
  currentTotalDiscountsSet?: ShopifyMoneyBag | null;
  currentShippingPriceSet?: ShopifyMoneyBag | null;
  currentTotalTaxSet?: ShopifyMoneyBag | null;
  currentTotalPriceSet?: ShopifyMoneyBag | null;
  originalTotalPriceSet?: ShopifyMoneyBag | null;
  netPaymentSet?: ShopifyMoneyBag | null;
  totalRefundedSet?: ShopifyMoneyBag | null;
  customer?: { id?: string | null } | null;
  lineItems?: {
    nodes?: Array<{
      id?: string;
      title?: string | null;
      sku?: string | null;
      currentQuantity?: number | null;
      originalUnitPriceSet?: ShopifyMoneyBag | null;
      priceAfterAllDiscountsBeforeTaxesSet?: ShopifyMoneyBag | null;
      product?: { id?: string | null } | null;
      variant?: { id?: string | null } | null;
    }>;
    pageInfo?: { hasNextPage?: boolean };
  } | null;
};

// Shopify respinge orice interogare cu cost estimat > 1000 (HTTP 200 + errors).
// Cost conexiune = 2 + first × costul unui nod; obiectele costă 1, scalarii 0.
// Estimări pe nod pentru interogările de mai jos:
//   produs    ≈ 1 + media(2 + 8×2) + variants(2 + 50×3)            ≈ 171
//   comandă   ≈ 1 + 8 MoneyBag×2 + customer + lineItems(2 + 50×7) ≈ 370
//   client    ≈ 1 + defaultAddress                                 ≈ 2
// Plafoanele păstrează fiecare pagină sub ~900 puncte, indiferent de `limit`.
const SHOPIFY_MAX_FIRST = 250;
export const SHOPIFY_PRODUCT_PAGE_MAX = 5;
export const SHOPIFY_ORDER_PAGE_MAX = 2;
export const SHOPIFY_CUSTOMER_PAGE_MAX = SHOPIFY_MAX_FIRST;

export function shopifyPageSize(limit: number, max: number): number {
  const n = Number.isFinite(limit) ? Math.trunc(limit) : 1;
  return Math.max(1, Math.min(n, max, SHOPIFY_MAX_FIRST));
}

const QUERY = `
query SwypikCatalog($first: Int!, $after: String) {
  shop { currencyCode }
  products(first: $first, after: $after, sortKey: UPDATED_AT) {
    nodes {
      id
      title
      description
      vendor
      productType
      status
      handle
      totalInventory
      onlineStoreUrl
      media(first: 8) {
        nodes {
          ... on MediaImage { image { url } }
        }
      }
      variants(first: 50) {
        nodes {
          id
          title
          sku
          price
          compareAtPrice
          inventoryQuantity
          inventoryPolicy
          inventoryItem { tracked }
          selectedOptions { name value }
        }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const CUSTOMERS_QUERY = `
query SwypikCustomers($first: Int!, $after: String) {
  customers(first: $first, after: $after, sortKey: UPDATED_AT) {
    nodes {
      id
      displayName
      firstName
      lastName
      email
      phone
      defaultAddress {
        address1
        address2
        city
        province
        country
        zip
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ORDERS_QUERY = `
query SwypikOrders($first: Int!, $after: String) {
  orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: false, query: "status:any") {
    nodes {
      id
      name
      createdAt
      cancelledAt
      currencyCode
      displayFinancialStatus
      displayFulfillmentStatus
      currentSubtotalPriceSet { shopMoney { amount currencyCode } }
      currentTotalDiscountsSet { shopMoney { amount currencyCode } }
      currentShippingPriceSet { shopMoney { amount currencyCode } }
      currentTotalTaxSet { shopMoney { amount currencyCode } }
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      originalTotalPriceSet { shopMoney { amount currencyCode } }
      netPaymentSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      customer { id }
      lineItems(first: 50) {
        nodes {
          id
          title
          sku
          currentQuantity
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount currencyCode } }
          product { id }
          variant { id }
        }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const PRODUCT_BY_ID_QUERY = `
query SwypikProductById($id: ID!) {
  shop { currencyCode }
  product(id: $id) {
    id title description vendor productType status handle totalInventory onlineStoreUrl
    media(first: 8) {
      nodes { ... on MediaImage { image { url } } }
    }
    variants(first: 50) {
      nodes {
        id title sku price compareAtPrice inventoryQuantity inventoryPolicy
        inventoryItem { tracked }
        selectedOptions { name value }
      }
      pageInfo { hasNextPage }
    }
  }
}`;

const CUSTOMER_BY_ID_QUERY = `
query SwypikCustomerById($id: ID!) {
  customer(id: $id) {
    id displayName firstName lastName email phone
    defaultAddress { address1 address2 city province country zip }
  }
}`;

const ORDER_BY_ID_QUERY = `
query SwypikOrderById($id: ID!) {
  order(id: $id) {
    id name createdAt cancelledAt currencyCode displayFinancialStatus displayFulfillmentStatus
    currentSubtotalPriceSet { shopMoney { amount currencyCode } }
    currentTotalDiscountsSet { shopMoney { amount currencyCode } }
    currentShippingPriceSet { shopMoney { amount currencyCode } }
    currentTotalTaxSet { shopMoney { amount currencyCode } }
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    originalTotalPriceSet { shopMoney { amount currencyCode } }
    netPaymentSet { shopMoney { amount currencyCode } }
    totalRefundedSet { shopMoney { amount currencyCode } }
    customer { id }
    lineItems(first: 100) {
      nodes {
        id title sku currentQuantity
        originalUnitPriceSet { shopMoney { amount currencyCode } }
        priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount currencyCode } }
        product { id }
        variant { id }
      }
      pageInfo { hasNextPage }
    }
  }
}`;

export { normalizeShopifyStore } from "./shopify-domain";

async function resolveShopifyCredentials(
  args: Pick<
    FetchCatalogPageArgs,
    "externalAccountId" | "credentials" | "sellerId" | "integrationId"
  >,
): Promise<ShopifyCredentials> {
  return ensureFreshShopifyCredentials({
    sellerId: args.sellerId,
    integrationId: args.integrationId,
    shop: args.externalAccountId,
    credentials: args.credentials as ShopifyCredentials,
  });
}

async function shopifyGraphql<T>(
  store: string,
  credentials: ShopifyCredentials,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  if (!credentials.accessToken?.trim()) {
    throw new CatalogProviderError("shopify_credentials_missing", 400);
  }
  const apiVersion = process.env.SHOPIFY_API_VERSION?.trim();
  if (!apiVersion) throw new CatalogProviderError("shopify_api_version_missing", 500);
  if (!/^20\d{2}-(?:01|04|07|10)$/.test(apiVersion)) {
    throw new CatalogProviderError("shopify_api_version_invalid", 500);
  }
  const response = await safeFetch(
    `https://${store}/admin/api/${apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": credentials.accessToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(
        intEnv("CATALOG_IMPORT_HTTP_TIMEOUT_MS", 15_000, 1_000, 60_000),
      ),
    },
  );
  if (!response.ok) {
    throw new CatalogProviderError(
      response.status === 401 || response.status === 403
        ? "shopify_unauthorized"
        : "shopify_request_failed",
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }
  const payload = (await response.json().catch(() => null)) as T | null;
  if (!payload) throw new CatalogProviderError("shopify_invalid_response");
  return payload;
}

function variantAttributes(options: ShopifyVariant["selectedOptions"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of options ?? []) {
    const name = boundedText(item.name, 80);
    const value = boundedText(item.value, 80);
    if (name && value) out[name] = value;
  }
  return out;
}

function inventoryStatus(variant: ShopifyVariant): "in_stock" | "out_of_stock" | "preorder" | "unknown" {
  if (variant.inventoryItem?.tracked === false) return "in_stock";
  if (variant.inventoryQuantity == null) return "unknown";
  if (variant.inventoryQuantity > 0) return "in_stock";
  return variant.inventoryPolicy?.toUpperCase() === "CONTINUE" ? "preorder" : "out_of_stock";
}

function normalizeShopifyProduct(p: ShopifyProduct, currency: string): ExternalCatalogProduct {
  if (!p.id || !p.title?.trim()) throw new CatalogProviderError("shopify_product_invalid");
  const variants = (p.variants?.nodes ?? []).map((v) => ({
    externalId: v.id,
    sku: boundedText(v.sku, 64),
    title: boundedText(v.title, 120),
    attributes: variantAttributes(v.selectedOptions),
    priceCents: moneyToCents(v.price),
    compareAtPriceCents: moneyToCents(v.compareAtPrice),
    inventoryQuantity: v.inventoryQuantity == null ? null : positiveStock(v.inventoryQuantity),
    inventoryStatus: inventoryStatus(v),
  }));
  const prices = variants.map((v) => v.priceCents).filter((v): v is number => v != null);
  const compares = variants.map((v) => v.compareAtPriceCents).filter((v): v is number => v != null);
  const status: ExternalCatalogProduct["status"] =
    p.status?.toUpperCase() === "ACTIVE"
      ? "active"
      : p.status?.toUpperCase() === "ARCHIVED"
        ? "archived"
        : "draft";
  const productInventoryStatus =
    variants.some((v) => v.inventoryStatus === "in_stock")
      ? "in_stock"
      : variants.some((v) => v.inventoryStatus === "preorder")
        ? "preorder"
        : variants.length > 0 && variants.every((v) => v.inventoryStatus === "out_of_stock")
          ? "out_of_stock"
          : "unknown";
  return {
    externalId: p.id,
    title: p.title.trim().slice(0, 200),
    description: plainText(p.description),
    brand: boundedText(p.vendor, 120),
    category: boundedText(p.productType, 200),
    sourceUrl: p.onlineStoreUrl ?? null,
    currency,
    priceCents: prices.length ? Math.min(...prices) : 0,
    compareAtPriceCents: compares.length ? Math.min(...compares) : null,
    inventoryQuantity: positiveStock(p.totalInventory),
    inventoryStatus: productInventoryStatus,
    imageUrls: boundedImages((p.media?.nodes ?? []).map((m) => m.image?.url)),
    status,
    variants,
    variantsComplete: !p.variants?.pageInfo?.hasNextPage,
    metadata: { provider: "shopify", handle: p.handle ?? null },
  };
}

function normalizeShopifyCustomer(customer: ShopifyCustomer): ExternalCustomer | null {
  if (!customer.id) return null;
  const name =
    boundedText(customer.displayName, 200) ??
    boundedText([customer.firstName, customer.lastName].filter(Boolean).join(" "), 200) ??
    boundedText(customer.email, 200);
  if (!name) return null;
  const address = customer.defaultAddress;
  return {
    externalId: customer.id,
    name,
    email: boundedText(customer.email, 254),
    phone: boundedText(customer.phone, 32),
    address: boundedText([address?.address1, address?.address2].filter(Boolean).join(", "), 500),
    city: boundedText(address?.city, 100),
    region: boundedText(address?.province, 100),
    country: boundedText(address?.country, 100),
    postalCode: boundedText(address?.zip, 32),
    notes: null,
  };
}

export async function fetchShopifyCatalogPage(args: FetchCatalogPageArgs): Promise<CatalogPage> {
  const store = normalizeShopifyStore(args.externalAccountId);
  const credentials = await resolveShopifyCredentials(args);
  if (!credentials.accessToken?.trim()) {
    throw new CatalogProviderError("shopify_credentials_missing", 400);
  }

  const apiVersion = process.env.SHOPIFY_API_VERSION?.trim();
  if (!apiVersion) throw new CatalogProviderError("shopify_api_version_missing", 500);
  if (!/^20\d{2}-(?:01|04|07|10)$/.test(apiVersion)) {
    throw new CatalogProviderError("shopify_api_version_invalid", 500);
  }

  const endpoint = `https://${store}/admin/api/${apiVersion}/graphql.json`;
  const response = await safeFetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": credentials.accessToken,
    },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        first: shopifyPageSize(args.limit, SHOPIFY_PRODUCT_PAGE_MAX),
        after: args.cursor || null,
      },
    }),
    signal: AbortSignal.timeout(
      intEnv("CATALOG_IMPORT_HTTP_TIMEOUT_MS", 15_000, 1_000, 60_000),
    ),
  });

  if (!response.ok) {
    throw new CatalogProviderError(
      response.status === 401 || response.status === 403
        ? "shopify_unauthorized"
        : "shopify_request_failed",
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }

  const payload = (await response.json().catch(() => null)) as ShopifyResponse | null;
  if (!payload || payload.errors?.length || !payload.data?.products) {
    throw new CatalogProviderError("shopify_invalid_response");
  }

  const currency = normalizeCurrency(payload.data.shop?.currencyCode);
  const products = (payload.data.products.nodes ?? []).map((p) => normalizeShopifyProduct(p, currency));

  return {
    products,
    nextCursor: payload.data.products.pageInfo?.hasNextPage
      ? payload.data.products.pageInfo.endCursor ?? null
      : null,
    storeCurrency: currency,
  };
}

export async function fetchShopifyCustomerPage(args: FetchCatalogPageArgs): Promise<CustomerPage> {
  const store = normalizeShopifyStore(args.externalAccountId);
  const credentials = await resolveShopifyCredentials(args);
  if (!credentials.accessToken?.trim()) {
    throw new CatalogProviderError("shopify_credentials_missing", 400);
  }

  const apiVersion = process.env.SHOPIFY_API_VERSION?.trim();
  if (!apiVersion) throw new CatalogProviderError("shopify_api_version_missing", 500);
  if (!/^20\d{2}-(?:01|04|07|10)$/.test(apiVersion)) {
    throw new CatalogProviderError("shopify_api_version_invalid", 500);
  }

  const endpoint = `https://${store}/admin/api/${apiVersion}/graphql.json`;
  const response = await safeFetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": credentials.accessToken,
    },
    body: JSON.stringify({
      query: CUSTOMERS_QUERY,
      variables: {
        first: shopifyPageSize(args.limit, SHOPIFY_CUSTOMER_PAGE_MAX),
        after: args.cursor || null,
      },
    }),
    signal: AbortSignal.timeout(
      intEnv("CATALOG_IMPORT_HTTP_TIMEOUT_MS", 15_000, 1_000, 60_000),
    ),
  });

  if (!response.ok) {
    throw new CatalogProviderError(
      response.status === 401 || response.status === 403
        ? "shopify_unauthorized"
        : "shopify_request_failed",
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    data?: {
      customers?: {
        nodes?: ShopifyCustomer[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    };
    errors?: Array<{ message?: string }>;
  } | null;

  if (!payload || payload.errors?.length || !payload.data?.customers) {
    throw new CatalogProviderError("shopify_customers_unavailable", 422);
  }

  return {
    customers: (payload.data.customers.nodes ?? []).flatMap((customer) => {
      const normalized = normalizeShopifyCustomer(customer);
      return normalized ? [normalized] : [];
    }),
    nextCursor: payload.data.customers.pageInfo?.hasNextPage
      ? payload.data.customers.pageInfo.endCursor ?? null
      : null,
  };
}

function moneyBagCents(value: ShopifyMoneyBag | null | undefined): number {
  return moneyToCents(value?.shopMoney?.amount) ?? 0;
}

function normalizeShopifyOrderStatus(
  order: ShopifyOrder,
  refundedCents: number,
  netPaymentCents: number,
): ExternalOrder["normalizedStatus"] {
  if (order.cancelledAt) return "cancelled";
  const financial = order.displayFinancialStatus?.toUpperCase() ?? "";
  const fulfillment = order.displayFulfillmentStatus?.toUpperCase() ?? "";
  if (financial === "REFUNDED") return "refunded";
  if (financial === "PARTIALLY_REFUNDED" || refundedCents > 0) return "partially_refunded";
  if (financial === "VOIDED" || financial === "EXPIRED") return "failed";
  if (financial === "PAID" || financial === "PARTIALLY_PAID") {
    return fulfillment === "FULFILLED" ? "fulfilled" : "paid";
  }
  if (financial === "PENDING" || financial === "AUTHORIZED") return "open";
  if (fulfillment === "FULFILLED" && netPaymentCents > 0) return "fulfilled";
  return "unknown";
}

function normalizeShopifyOrder(order: ShopifyOrder): ExternalOrder | null {
  if (!order.id || !order.createdAt) return null;
  const currency = normalizeCurrency(order.currencyCode);
  const currentTotal = moneyBagCents(order.currentTotalPriceSet);
  const originalTotal = moneyBagCents(order.originalTotalPriceSet);
  const refundedCents = moneyBagCents(order.totalRefundedSet);
  const netPaymentCents = moneyBagCents(order.netPaymentSet);
  const items = (order.lineItems?.nodes ?? []).flatMap((item) => {
    if (!item.id || !item.title?.trim()) return [];
    const quantity = Math.max(0, Math.trunc(item.currentQuantity ?? 0));
    if (quantity <= 0) return [];
    const totalAmountCents = moneyBagCents(item.priceAfterAllDiscountsBeforeTaxesSet);
    const unitAmountCents =
      totalAmountCents > 0
        ? Math.round(totalAmountCents / quantity)
        : moneyBagCents(item.originalUnitPriceSet);
    return [{
      externalId: item.id,
      externalProductId: item.product?.id ?? null,
      externalVariantId: item.variant?.id ?? null,
      title: item.title.trim().slice(0, 300),
      sku: boundedText(item.sku, 120),
      quantity,
      currency,
      unitAmountCents,
      totalAmountCents: totalAmountCents || unitAmountCents * quantity,
      metadata: {},
    }];
  });
  return {
    externalId: order.id,
    orderNumber: boundedText(order.name, 120),
    normalizedStatus: normalizeShopifyOrderStatus(order, refundedCents, netPaymentCents),
    providerStatus: order.displayFinancialStatus ?? null,
    financialStatus: order.displayFinancialStatus ?? null,
    fulfillmentStatus: order.displayFulfillmentStatus ?? null,
    currency,
    subtotalCents: moneyBagCents(order.currentSubtotalPriceSet),
    discountCents: moneyBagCents(order.currentTotalDiscountsSet),
    shippingCents: moneyBagCents(order.currentShippingPriceSet),
    taxCents: moneyBagCents(order.currentTotalTaxSet),
    totalCents: netPaymentCents,
    refundedCents,
    customerExternalId: order.customer?.id ?? null,
    customerName: null,
    customerEmail: null,
    customerPhone: null,
    placedAt: order.createdAt,
    cancelledAt: order.cancelledAt ?? null,
    items,
    itemsComplete: !order.lineItems?.pageInfo?.hasNextPage,
    metadata: {
      original_total_cents: originalTotal,
      current_total_cents: currentTotal,
    },
  };
}

export async function fetchShopifyOrderPage(args: FetchCatalogPageArgs): Promise<OrderPage> {
  const store = normalizeShopifyStore(args.externalAccountId);
  const credentials = await resolveShopifyCredentials(args);
  if (!credentials.accessToken?.trim()) {
    throw new CatalogProviderError("shopify_credentials_missing", 400);
  }
  const apiVersion = process.env.SHOPIFY_API_VERSION?.trim();
  if (!apiVersion) throw new CatalogProviderError("shopify_api_version_missing", 500);
  if (!/^20\d{2}-(?:01|04|07|10)$/.test(apiVersion)) {
    throw new CatalogProviderError("shopify_api_version_invalid", 500);
  }

  const response = await safeFetch(
    `https://${store}/admin/api/${apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": credentials.accessToken,
      },
      body: JSON.stringify({
        query: ORDERS_QUERY,
        variables: {
          first: shopifyPageSize(args.limit, SHOPIFY_ORDER_PAGE_MAX),
          after: args.cursor || null,
        },
      }),
      signal: AbortSignal.timeout(
        intEnv("CATALOG_IMPORT_HTTP_TIMEOUT_MS", 15_000, 1_000, 60_000),
      ),
    },
  );
  if (!response.ok) {
    throw new CatalogProviderError(
      response.status === 401 || response.status === 403
        ? "shopify_unauthorized"
        : "shopify_request_failed",
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    data?: {
      orders?: {
        nodes?: ShopifyOrder[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    };
    errors?: Array<{ message?: string }>;
  } | null;
  if (!payload || payload.errors?.length || !payload.data?.orders) {
    throw new CatalogProviderError("shopify_orders_unavailable", 422);
  }

  const orders = (payload.data.orders.nodes ?? []).flatMap((order) => {
    const normalized = normalizeShopifyOrder(order);
    return normalized ? [normalized] : [];
  });

  return {
    orders,
    nextCursor: payload.data.orders.pageInfo?.hasNextPage
      ? payload.data.orders.pageInfo.endCursor ?? null
      : null,
  };
}

export async function fetchShopifyProductById(
  args: Omit<FetchCatalogPageArgs, "cursor" | "limit">,
  externalId: string,
): Promise<ExternalCatalogProduct | null> {
  const store = normalizeShopifyStore(args.externalAccountId);
  const credentials = await resolveShopifyCredentials(args);
  const payload = await shopifyGraphql<{
    data?: { shop?: { currencyCode?: string | null }; product?: ShopifyProduct | null };
    errors?: Array<{ message?: string }>;
  }>(
    store,
    credentials,
    PRODUCT_BY_ID_QUERY,
    { id: externalId },
  );
  if (payload.errors?.length) throw new CatalogProviderError("shopify_invalid_response");
  if (!payload.data?.product) return null;
  return normalizeShopifyProduct(payload.data.product, normalizeCurrency(payload.data.shop?.currencyCode));
}

export async function fetchShopifyCustomerById(
  args: Omit<FetchCatalogPageArgs, "cursor" | "limit">,
  externalId: string,
): Promise<ExternalCustomer | null> {
  const store = normalizeShopifyStore(args.externalAccountId);
  const credentials = await resolveShopifyCredentials(args);
  const payload = await shopifyGraphql<{
    data?: { customer?: ShopifyCustomer | null };
    errors?: Array<{ message?: string }>;
  }>(
    store,
    credentials,
    CUSTOMER_BY_ID_QUERY,
    { id: externalId },
  );
  if (payload.errors?.length) throw new CatalogProviderError("shopify_customers_unavailable", 422);
  return payload.data?.customer ? normalizeShopifyCustomer(payload.data.customer) : null;
}

export async function fetchShopifyOrderById(
  args: Omit<FetchCatalogPageArgs, "cursor" | "limit">,
  externalId: string,
): Promise<ExternalOrder | null> {
  const store = normalizeShopifyStore(args.externalAccountId);
  const credentials = await resolveShopifyCredentials(args);
  const payload = await shopifyGraphql<{
    data?: { order?: ShopifyOrder | null };
    errors?: Array<{ message?: string }>;
  }>(
    store,
    credentials,
    ORDER_BY_ID_QUERY,
    { id: externalId },
  );
  if (payload.errors?.length) throw new CatalogProviderError("shopify_orders_unavailable", 422);
  return payload.data?.order ? normalizeShopifyOrder(payload.data.order) : null;
}
