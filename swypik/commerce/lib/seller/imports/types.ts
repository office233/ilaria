export const CATALOG_PROVIDERS = ["shopify", "woocommerce"] as const;
export type CatalogProvider = (typeof CATALOG_PROVIDERS)[number];

export type ExternalCatalogVariant = {
  externalId: string;
  sku: string | null;
  title: string | null;
  attributes: Record<string, string>;
  priceCents: number | null;
  compareAtPriceCents: number | null;
  inventoryQuantity: number | null;
  inventoryStatus: "in_stock" | "out_of_stock" | "preorder" | "unknown";
};

export type ExternalCatalogProduct = {
  externalId: string;
  title: string;
  description: string | null;
  brand: string | null;
  category: string | null;
  sourceUrl: string | null;
  currency: string;
  priceCents: number;
  compareAtPriceCents: number | null;
  inventoryQuantity: number;
  inventoryStatus: "in_stock" | "out_of_stock" | "preorder" | "unknown";
  imageUrls: string[];
  status: "active" | "draft" | "archived";
  variants: ExternalCatalogVariant[];
  variantsComplete: boolean;
  metadata: Record<string, unknown>;
};

export type CatalogPage = {
  products: ExternalCatalogProduct[];
  nextCursor: string | null;
  storeCurrency: string;
};

export type ExternalCustomer = {
  externalId: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  postalCode: string | null;
  notes: string | null;
};

export type CustomerPage = {
  customers: ExternalCustomer[];
  nextCursor: string | null;
};

export type ImportedOrderStatus =
  | "open"
  | "paid"
  | "fulfilled"
  | "cancelled"
  | "refunded"
  | "partially_refunded"
  | "failed"
  | "unknown";

export type ExternalOrderItem = {
  externalId: string;
  externalProductId: string | null;
  externalVariantId: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  currency: string;
  unitAmountCents: number;
  totalAmountCents: number;
  metadata: Record<string, unknown>;
};

export type ExternalOrder = {
  externalId: string;
  orderNumber: string | null;
  normalizedStatus: ImportedOrderStatus;
  providerStatus: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  refundedCents: number;
  customerExternalId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  placedAt: string;
  cancelledAt: string | null;
  items: ExternalOrderItem[];
  itemsComplete: boolean;
  metadata: Record<string, unknown>;
};

export type OrderPage = {
  orders: ExternalOrder[];
  nextCursor: string | null;
};

export type ShopifyCredentials = {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  scope?: string;
};
export type WooCommerceCredentials = { consumerKey: string; consumerSecret: string };
export type CatalogCredentials = ShopifyCredentials | WooCommerceCredentials;

export type CatalogConnection = {
  id: string;
  sellerId: string;
  provider: CatalogProvider;
  externalAccountId: string;
  credentials: CatalogCredentials;
  config: Record<string, unknown>;
  status: "active" | "disabled" | "error";
  lastSyncAt: string | null;
  lastSyncCursor: string | null;
  lastErrorCode: string | null;
  lastCustomerSyncAt: string | null;
  lastCustomerSyncCursor: string | null;
  lastCustomerErrorCode: string | null;
  lastOrderSyncAt: string | null;
  lastOrderSyncCursor: string | null;
  lastOrderErrorCode: string | null;
  webhookStatus: "pending" | "active" | "degraded" | "unavailable";
  webhookConfig: Record<string, unknown>;
  webhooksUpdatedAt: string | null;
  lastReconcileAt: string | null;
  lastReconcileErrorCode: string | null;
};

export type CatalogConnectionSummary = Omit<CatalogConnection, "credentials">;

export type FetchCatalogPageArgs = {
  externalAccountId: string;
  credentials: CatalogCredentials;
  sellerId?: string;
  integrationId?: string;
  cursor?: string | null;
  limit: number;
};
