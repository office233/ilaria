import { intEnv } from "@/lib/config/env";
import { assertPublicHttpsUrl, safeFetch } from "@/lib/security/ssrf";
import type {
  CatalogPage,
  CustomerPage,
  ExternalCustomer,
  ExternalOrder,
  ExternalCatalogProduct,
  FetchCatalogPageArgs,
  OrderPage,
  WooCommerceCredentials,
} from "./types";
import {
  boundedImages,
  boundedText,
  boundedVariants,
  CatalogProviderError,
  moneyMagnitudeToCents,
  moneyToCents,
  normalizeCurrency,
  plainText,
  positiveStock,
} from "./common";

type WooAttribute = { name?: string | null; option?: string | null };
type WooVariation = {
  id: number;
  sku?: string | null;
  price?: string | null;
  regular_price?: string | null;
  stock_quantity?: number | null;
  stock_status?: string | null;
  attributes?: WooAttribute[];
};
type WooProduct = {
  id: number;
  name?: string | null;
  description?: string | null;
  short_description?: string | null;
  sku?: string | null;
  status?: string | null;
  type?: string | null;
  permalink?: string | null;
  price?: string | null;
  regular_price?: string | null;
  stock_quantity?: number | null;
  stock_status?: string | null;
  categories?: Array<{ name?: string | null }>;
  images?: Array<{ src?: string | null }>;
  variations?: number[];
};
type WooCustomer = {
  id?: number;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  billing?: {
    first_name?: string | null;
    last_name?: string | null;
    company?: string | null;
    address_1?: string | null;
    address_2?: string | null;
    city?: string | null;
    state?: string | null;
    postcode?: string | null;
    country?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
};
type WooOrder = {
  id?: number;
  number?: string | null;
  status?: string | null;
  currency?: string | null;
  date_created_gmt?: string | null;
  date_created?: string | null;
  date_completed_gmt?: string | null;
  discount_total?: string | null;
  shipping_total?: string | null;
  total_tax?: string | null;
  total?: string | null;
  customer_id?: number | null;
  billing?: {
    first_name?: string | null;
    last_name?: string | null;
    company?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  line_items?: Array<{
    id?: number;
    name?: string | null;
    product_id?: number | null;
    variation_id?: number | null;
    quantity?: number | null;
    subtotal?: string | null;
    total?: string | null;
    sku?: string | null;
    price?: number | string | null;
  }>;
  refunds?: Array<{ id?: number; total?: string | null }>;
};

function wooInventoryStatus(value: string | null | undefined): "in_stock" | "out_of_stock" | "preorder" | "unknown" {
  if (value === "instock") return "in_stock";
  if (value === "outofstock") return "out_of_stock";
  if (value === "onbackorder") return "preorder";
  return "unknown";
}

export async function normalizeWooStore(raw: string): Promise<string> {
  const url = await assertPublicHttpsUrl(raw.trim().replace(/\/+$/, ""));
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function authHeader(credentials: WooCommerceCredentials): string {
  if (!credentials.consumerKey?.trim() || !credentials.consumerSecret?.trim()) {
    throw new CatalogProviderError("woocommerce_credentials_missing", 400);
  }
  return `Basic ${Buffer.from(
    `${credentials.consumerKey}:${credentials.consumerSecret}`,
    "utf8",
  ).toString("base64")}`;
}

async function wooFetch(
  store: string,
  path: string,
  credentials: WooCommerceCredentials,
): Promise<Response> {
  const response = await safeFetch(`${store}/wp-json/wc/v3/${path}`, {
    headers: {
      Authorization: authHeader(credentials),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(
      intEnv("CATALOG_IMPORT_HTTP_TIMEOUT_MS", 15_000, 1_000, 60_000),
    ),
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new CatalogProviderError("woocommerce_not_found", 404);
    }
    throw new CatalogProviderError(
      response.status === 401 || response.status === 403
        ? "woocommerce_unauthorized"
        : "woocommerce_request_failed",
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }
  return response;
}

async function fetchCurrency(
  store: string,
  credentials: WooCommerceCredentials,
): Promise<string> {
  const response = await wooFetch(store, "data/currencies/current", credentials);
  const payload = (await response.json().catch(() => null)) as { code?: string } | null;
  return normalizeCurrency(payload?.code);
}

async function fetchVariations(
  store: string,
  product: WooProduct,
  credentials: WooCommerceCredentials,
) {
  if (product.type !== "variable" || !(product.variations?.length)) {
    return { items: [], complete: true };
  }

  const configuredMax = intEnv("CATALOG_IMPORT_MAX_VARIANTS", 50, 1, 100);
  const response = await wooFetch(
    store,
    `products/${product.id}/variations?per_page=${configuredMax}&page=1`,
    credentials,
  );
  const payload = (await response.json().catch(() => null)) as WooVariation[] | null;
  if (!Array.isArray(payload)) {
    throw new CatalogProviderError("woocommerce_invalid_variations");
  }
  const totalPages = Number(response.headers.get("x-wp-totalpages") || "1");
  const bounded = boundedVariants(payload);
  return {
    items: bounded.items.map((v) => {
      const attrs: Record<string, string> = {};
      for (const item of v.attributes ?? []) {
        const name = boundedText(item.name, 80);
        const value = boundedText(item.option, 80);
        if (name && value) attrs[name] = value;
      }
      return {
        externalId: String(v.id),
        sku: boundedText(v.sku, 64),
        title: null,
        attributes: attrs,
        priceCents: moneyToCents(v.price),
        compareAtPriceCents: moneyToCents(v.regular_price),
        inventoryQuantity: v.stock_quantity == null ? null : positiveStock(v.stock_quantity),
        inventoryStatus: wooInventoryStatus(v.stock_status),
      };
    }),
    complete: bounded.complete && totalPages <= 1,
  };
}

async function normalizeWooProduct(
  store: string,
  credentials: WooCommerceCredentials,
  currency: string,
  p: WooProduct,
): Promise<ExternalCatalogProduct> {
  if (!Number.isInteger(p.id) || !p.name?.trim()) {
    throw new CatalogProviderError("woocommerce_product_invalid");
  }
  const variants = await fetchVariations(store, p, credentials);
  const variantPrices = variants.items
    .map((v) => v.priceCents)
    .filter((v): v is number => v != null);
  const basePrice = moneyToCents(p.price) ?? (variantPrices.length ? Math.min(...variantPrices) : 0);
  const compare = moneyToCents(p.regular_price);
  const status: ExternalCatalogProduct["status"] =
    p.status === "publish" ? "active" : p.status === "trash" ? "archived" : "draft";
  return {
    externalId: String(p.id),
    title: p.name.trim().slice(0, 200),
    description: plainText(p.description) ?? plainText(p.short_description),
    brand: null,
    category: boundedText(p.categories?.[0]?.name, 200),
    sourceUrl: p.permalink ?? null,
    currency,
    priceCents: basePrice,
    compareAtPriceCents: compare != null && compare >= basePrice ? compare : null,
    inventoryQuantity: positiveStock(
      p.stock_quantity ?? variants.items.reduce((sum, v) => sum + (v.inventoryQuantity ?? 0), 0),
    ),
    inventoryStatus: wooInventoryStatus(p.stock_status),
    imageUrls: boundedImages((p.images ?? []).map((image) => image.src)),
    status,
    variants: variants.items,
    variantsComplete: variants.complete,
    metadata: { provider: "woocommerce", type: p.type ?? null, sku: boundedText(p.sku, 64) },
  };
}

function normalizeWooCustomer(customer: WooCustomer): ExternalCustomer | null {
  if (!Number.isInteger(customer.id)) return null;
  const billing = customer.billing;
  const name =
    boundedText(
      [customer.first_name || billing?.first_name, customer.last_name || billing?.last_name]
        .filter(Boolean)
        .join(" "),
      200,
    ) ??
    boundedText(billing?.company, 200) ??
    boundedText(customer.email || billing?.email, 200);
  if (!name) return null;
  return {
    externalId: String(customer.id),
    name,
    email: boundedText(customer.email || billing?.email, 254),
    phone: boundedText(billing?.phone, 32),
    address: boundedText([billing?.address_1, billing?.address_2].filter(Boolean).join(", "), 500),
    city: boundedText(billing?.city, 100),
    region: boundedText(billing?.state, 100),
    country: boundedText(billing?.country, 100),
    postalCode: boundedText(billing?.postcode, 32),
    notes: null,
  };
}

export async function fetchWooCommerceCatalogPage(
  args: FetchCatalogPageArgs,
): Promise<CatalogPage> {
  const store = await normalizeWooStore(args.externalAccountId);
  const credentials = args.credentials as WooCommerceCredentials;
  const currency = await fetchCurrency(store, credentials);
  const page = Math.max(1, Number.parseInt(args.cursor || "1", 10) || 1);

  const response = await wooFetch(
    store,
    `products?per_page=${args.limit}&page=${page}&orderby=modified&order=asc`,
    credentials,
  );
  const payload = (await response.json().catch(() => null)) as WooProduct[] | null;
  if (!Array.isArray(payload)) {
    throw new CatalogProviderError("woocommerce_invalid_response");
  }
  const totalPages = Math.max(1, Number(response.headers.get("x-wp-totalpages") || "1"));

  const products: ExternalCatalogProduct[] = [];
  for (const p of payload) products.push(await normalizeWooProduct(store, credentials, currency, p));

  return {
    products,
    nextCursor: page < totalPages ? String(page + 1) : null,
    storeCurrency: currency,
  };
}

export async function fetchWooCommerceCustomerPage(
  args: FetchCatalogPageArgs,
): Promise<CustomerPage> {
  const store = await normalizeWooStore(args.externalAccountId);
  const credentials = args.credentials as WooCommerceCredentials;
  const page = Math.max(1, Number.parseInt(args.cursor || "1", 10) || 1);
  const response = await wooFetch(
    store,
    `customers?per_page=${args.limit}&page=${page}&orderby=registered&order=asc`,
    credentials,
  );
  const payload = (await response.json().catch(() => null)) as WooCustomer[] | null;
  if (!Array.isArray(payload)) {
    throw new CatalogProviderError("woocommerce_customers_unavailable", 422);
  }
  const totalPages = Math.max(1, Number(response.headers.get("x-wp-totalpages") || "1"));

  return {
    customers: payload.flatMap((customer) => {
      const normalized = normalizeWooCustomer(customer);
      return normalized ? [normalized] : [];
    }),
    nextCursor: page < totalPages ? String(page + 1) : null,
  };
}

function normalizeWooOrderStatus(status: string | null | undefined, refundedCents: number): ExternalOrder["normalizedStatus"] {
  if (status === "cancelled" || status === "trash") return "cancelled";
  if (status === "refunded") return "refunded";
  if (refundedCents > 0) return "partially_refunded";
  if (status === "failed") return "failed";
  if (status === "completed") return "fulfilled";
  if (status === "processing") return "paid";
  if (status === "pending" || status === "on-hold") return "open";
  return "unknown";
}

function normalizeWooOrder(order: WooOrder): ExternalOrder | null {
  if (!Number.isInteger(order.id)) return null;
  const placedAtRaw = order.date_created_gmt || order.date_created;
  if (!placedAtRaw) return null;
  const placedAt = /z$/i.test(placedAtRaw) ? placedAtRaw : `${placedAtRaw}Z`;
  if (Number.isNaN(Date.parse(placedAt))) return null;
  const currency = normalizeCurrency(order.currency);
  const refundedCents = (order.refunds ?? []).reduce(
    (sum, refund) => sum + (moneyMagnitudeToCents(refund.total) ?? 0),
    0,
  );
  const grossTotalCents = moneyToCents(order.total) ?? 0;
  const totalCents = order.status === "refunded" ? 0 : Math.max(0, grossTotalCents - refundedCents);
  const items = (order.line_items ?? []).flatMap((item) => {
    if (!Number.isInteger(item.id) || !item.name?.trim()) return [];
    const quantity = Math.max(0, Math.trunc(item.quantity ?? 0));
    if (quantity <= 0) return [];
    const totalAmountCents = moneyToCents(item.total) ?? 0;
    const unitAmountCents =
      totalAmountCents > 0
        ? Math.round(totalAmountCents / quantity)
        : moneyToCents(item.price) ?? 0;
    return [{
      externalId: String(item.id),
      externalProductId: item.product_id ? String(item.product_id) : null,
      externalVariantId: item.variation_id ? String(item.variation_id) : null,
      title: item.name.trim().slice(0, 300),
      sku: boundedText(item.sku, 120),
      quantity,
      currency,
      unitAmountCents,
      totalAmountCents: totalAmountCents || unitAmountCents * quantity,
      metadata: {},
    }];
  });
  const billing = order.billing;
  const customerName =
    boundedText([billing?.first_name, billing?.last_name].filter(Boolean).join(" "), 200) ??
    boundedText(billing?.company, 200);
  return {
    externalId: String(order.id),
    orderNumber: boundedText(order.number, 120),
    normalizedStatus: normalizeWooOrderStatus(order.status, refundedCents),
    providerStatus: order.status ?? null,
    financialStatus: order.status ?? null,
    fulfillmentStatus: order.status === "completed" ? "fulfilled" : null,
    currency,
    subtotalCents: Math.max(0, items.reduce((sum, item) => sum + item.totalAmountCents, 0)),
    discountCents: moneyToCents(order.discount_total) ?? 0,
    shippingCents: moneyToCents(order.shipping_total) ?? 0,
    taxCents: moneyToCents(order.total_tax) ?? 0,
    totalCents,
    refundedCents,
    customerExternalId: order.customer_id && order.customer_id > 0 ? String(order.customer_id) : null,
    customerName,
    customerEmail: boundedText(billing?.email, 254),
    customerPhone: boundedText(billing?.phone, 32),
    placedAt,
    cancelledAt: order.status === "cancelled" ? placedAt : null,
    items,
    itemsComplete: true,
    metadata: {
      gross_total_cents: grossTotalCents,
      completed_at: order.date_completed_gmt ?? null,
    },
  };
}

export async function fetchWooCommerceOrderPage(
  args: FetchCatalogPageArgs,
): Promise<OrderPage> {
  const store = await normalizeWooStore(args.externalAccountId);
  const credentials = args.credentials as WooCommerceCredentials;
  const page = Math.max(1, Number.parseInt(args.cursor || "1", 10) || 1);
  const response = await wooFetch(
    store,
    `orders?per_page=${args.limit}&page=${page}&orderby=date&order=asc`,
    credentials,
  );
  const payload = (await response.json().catch(() => null)) as WooOrder[] | null;
  if (!Array.isArray(payload)) {
    throw new CatalogProviderError("woocommerce_orders_unavailable", 422);
  }
  const totalPages = Math.max(1, Number(response.headers.get("x-wp-totalpages") || "1"));

  const orders = payload.flatMap((order) => {
    const normalized = normalizeWooOrder(order);
    return normalized ? [normalized] : [];
  });

  return {
    orders,
    nextCursor: page < totalPages ? String(page + 1) : null,
  };
}

export async function fetchWooCommerceProductById(
  args: Omit<FetchCatalogPageArgs, "cursor" | "limit">,
  externalId: string,
): Promise<ExternalCatalogProduct | null> {
  const store = await normalizeWooStore(args.externalAccountId);
  const credentials = args.credentials as WooCommerceCredentials;
  const currency = await fetchCurrency(store, credentials);
  try {
    const response = await wooFetch(store, `products/${encodeURIComponent(externalId)}`, credentials);
    const payload = (await response.json().catch(() => null)) as WooProduct | null;
    return payload ? normalizeWooProduct(store, credentials, currency, payload) : null;
  } catch (error) {
    if (error instanceof CatalogProviderError && error.status === 404) return null;
    throw error;
  }
}

export async function fetchWooCommerceCustomerById(
  args: Omit<FetchCatalogPageArgs, "cursor" | "limit">,
  externalId: string,
): Promise<ExternalCustomer | null> {
  const store = await normalizeWooStore(args.externalAccountId);
  const credentials = args.credentials as WooCommerceCredentials;
  try {
    const response = await wooFetch(store, `customers/${encodeURIComponent(externalId)}`, credentials);
    const payload = (await response.json().catch(() => null)) as WooCustomer | null;
    return payload ? normalizeWooCustomer(payload) : null;
  } catch (error) {
    if (error instanceof CatalogProviderError && error.status === 404) return null;
    throw error;
  }
}

export async function fetchWooCommerceOrderById(
  args: Omit<FetchCatalogPageArgs, "cursor" | "limit">,
  externalId: string,
): Promise<ExternalOrder | null> {
  const store = await normalizeWooStore(args.externalAccountId);
  const credentials = args.credentials as WooCommerceCredentials;
  try {
    const response = await wooFetch(store, `orders/${encodeURIComponent(externalId)}`, credentials);
    const payload = (await response.json().catch(() => null)) as WooOrder | null;
    return payload ? normalizeWooOrder(payload) : null;
  } catch (error) {
    if (error instanceof CatalogProviderError && error.status === 404) return null;
    throw error;
  }
}
