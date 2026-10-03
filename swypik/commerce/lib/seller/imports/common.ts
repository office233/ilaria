import { SELLER_PRODUCT_MAX_IMAGES, SELLER_PRODUCT_MAX_VARIANTS } from "@/lib/seller/config";
import { parsePublicHttpsUrl } from "@/lib/security/ssrf";

export class CatalogProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number = 502,
  ) {
    super(code);
    this.name = "CatalogProviderError";
  }
}

function roundedMoneyToCents(value: unknown, magnitude = false): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const raw = String(value).trim();
  if (raw.length > 64) return null;
  const normalized = magnitude && raw.startsWith("-") ? raw.slice(1) : raw;
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(normalized);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(3, "0");
  // Provider prices may have up to six decimal places. Round half-up using
  // decimal digits: binary floating-point makes e.g. 1.005 become 100 cents.
  const cents = BigInt(match[1]) * 100n + BigInt(fraction.slice(0, 2)) +
    (fraction[2] >= "5" ? 1n : 0n);
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

export function moneyToCents(value: unknown): number | null {
  return roundedMoneyToCents(value);
}

/** Refund APIs may represent the amount as either positive or negative. */
export function moneyMagnitudeToCents(value: unknown): number | null {
  return roundedMoneyToCents(value, true);
}

export function normalizeCurrency(value: unknown): string {
  const currency = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) throw new CatalogProviderError("unsupported_currency", 422);
  return currency;
}

export function plainText(value: unknown, maxLength = 5000): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, maxLength) : null;
}

export function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

export function boundedImages(urls: Array<string | null | undefined>): string[] {
  const unique: string[] = [];
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const parsed = parsePublicHttpsUrl(raw);
      const normalized = parsed.toString();
      if (!unique.includes(normalized)) unique.push(normalized);
    } catch {
      continue;
    }
    if (unique.length >= SELLER_PRODUCT_MAX_IMAGES) break;
  }
  return unique;
}

export function boundedVariants<T>(variants: T[]): { items: T[]; complete: boolean } {
  return {
    items: variants.slice(0, SELLER_PRODUCT_MAX_VARIANTS),
    complete: variants.length <= SELLER_PRODUCT_MAX_VARIANTS,
  };
}

export function positiveStock(value: unknown): number {
  const stock = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(stock)) return 0;
  return Math.max(0, Math.min(1_000_000, Math.trunc(stock)));
}
