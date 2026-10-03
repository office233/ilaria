export interface Product {
  id: string;
  title: string;
  slug: string;
  brand: string | null;
  category: string | null;
  status: string | null;
  source_type: string | null;
  inventory_status: string | null;
  product_url: string | null;
  image_url: string | null;
  currency: string | null;
  price_cents: number | null;
  created_at: string | null;
  updated_at: string | null;
  orders: number | null;
  has_video: boolean | null;
}

export type SortField = "title" | "price" | "date";
export type SortDir = "asc" | "desc";

export interface ServerTotals {
  total: number;
  active: number;
  with_image: number;
  with_video: number;
}

export const PAGE_SIZE = 20;

export const STATUS_OPTIONS = [
  { value: "all", labelKey: "statusAll" },
  { value: "active", labelKey: "statusActive" },
  { value: "draft", labelKey: "statusDraft" },
  { value: "inactive", labelKey: "statusInactive" },
] as const;

export const SOURCE_OPTIONS = [
  { value: "all", labelKey: "sourceAll" },
  { value: "local_seller", labelKey: "sourceLocalSeller" },
] as const;
