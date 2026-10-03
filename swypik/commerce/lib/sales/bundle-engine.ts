export type BundleProduct = {
  id: string;
  title: string;
  description?: string;
  category?: string;
  vendor?: string;
  price: number;
  oldPrice?: number;
  discountPercent?: number;
  qualityScore?: number;
  rating?: number;
  orders?: number;
  tags?: string;
  sku?: string;
};

// Romanian keys → English search terms (product titles in Neon DB are in English)
const COMPLEMENTARY_TERMS: Record<string, string[]> = {
  rochie: ["bag", "jewelry", "necklace", "earrings", "sandals", "perfume", "clutch"],
  rochii: ["bag", "jewelry", "necklace", "earrings", "sandals", "perfume", "clutch"],
  dress: ["bag", "jewelry", "necklace", "earrings", "sandals", "perfume", "clutch"],
  geanta: ["wallet", "dress", "jewelry", "sunglasses", "scarf"],
  geantă: ["wallet", "dress", "jewelry", "sunglasses", "scarf"],
  bag: ["wallet", "dress", "jewelry", "sunglasses", "scarf"],
  bijuterii: ["dress", "bag", "perfume", "gift box", "watch"],
  jewelry: ["dress", "bag", "perfume", "gift box", "watch"],
  colier: ["earrings", "bracelet", "dress", "bag", "ring"],
  necklace: ["earrings", "bracelet", "dress", "bag", "ring"],
  beauty: ["serum", "cream", "makeup", "organizer", "gift"],
  skincare: ["serum", "cream", "cleanser", "makeup", "organizer"],
  tricou: ["jeans", "hoodie", "cap", "watch", "sneakers"],
  "t-shirt": ["jeans", "hoodie", "cap", "watch", "sneakers"],
  shirt: ["jeans", "hoodie", "cap", "watch", "sneakers"],
  barbati: ["watch", "wallet", "t-shirt", "hoodie", "belt"],
  bărbați: ["watch", "wallet", "t-shirt", "hoodie", "belt"],
  men: ["watch", "wallet", "t-shirt", "hoodie", "belt"],
  casa: ["organizer", "lamp", "decor", "kitchen", "storage"],
  casă: ["organizer", "lamp", "decor", "kitchen", "storage"],
  home: ["organizer", "lamp", "decor", "kitchen", "storage"],
  cadou: ["jewelry", "beauty", "perfume", "accessories", "gift box"],
  gift: ["jewelry", "beauty", "perfume", "accessories", "gift box"],
  pants: ["belt", "shirt", "shoes", "watch", "jacket"],
  jeans: ["belt", "t-shirt", "sneakers", "hoodie", "jacket"],
  shoes: ["bag", "socks", "belt", "dress", "jeans"],
  sweater: ["scarf", "pants", "boots", "hat", "gloves"],
  jacket: ["t-shirt", "jeans", "boots", "scarf", "belt"],
  bikini: ["cover up", "sunglasses", "hat", "sandals", "beach bag"],
  swimwear: ["cover up", "sunglasses", "hat", "sandals", "beach bag"],
  pajamas: ["slippers", "robe", "blanket", "pillow", "sleep mask"],
  lingerie: ["robe", "pajamas", "perfume", "gift box", "stockings"],
};

function normalize(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function includesAny(haystack: string, terms: string[]) {
  const normalized = normalize(haystack);
  return terms.some((term) => normalized.includes(normalize(term)));
}

export function inferBundleQueries(query: string): string[] {
  const normalized = normalize(query);
  const matches = Object.entries(COMPLEMENTARY_TERMS)
    .filter(([key]) => normalized.includes(normalize(key)))
    .flatMap(([, terms]) => terms);

  const unique = Array.from(new Set(matches));

  if (unique.length > 0) return unique.slice(0, 6);

  return [
    `${query} accessories`,
    `${query} gift`,
    `${query} premium`,
  ];
}

export function scoreProduct(product: BundleProduct) {
  const rating = product.rating || 4.6;
  const orders = product.orders || 0;
  const quality = product.qualityScore || 8;
  const discount = product.discountPercent || 0;
  const pricePenalty = product.price > 300 ? 0.3 : product.price > 150 ? 0.15 : 0;

  return quality * 2 + rating + Math.min(orders / 100, 5) + discount / 10 - pricePenalty;
}

export function rankProducts<T extends BundleProduct>(products: T[]) {
  return [...products].sort((a, b) => scoreProduct(b) - scoreProduct(a));
}

export function pickBundleProducts<T extends BundleProduct>(mainProduct: T, products: T[], limit = 6) {
  const source = `${mainProduct.title} ${mainProduct.description || ""} ${mainProduct.category || ""}`;
  const queries = inferBundleQueries(source);

  const candidates = products.filter((p) => {
    if (p.id === mainProduct.id) return false;
    const haystack = `${p.title} ${p.description || ""} ${p.category || ""} ${p.vendor || ""} ${p.sku || ""}`;
    return includesAny(haystack, queries);
  });

  return rankProducts(candidates).slice(0, limit);
}

export function buildSalesSuggestion(mainProduct: BundleProduct, bundleProducts: BundleProduct[]) {
  if (bundleProducts.length === 0) {
    return `Produsul ales merge bine singur, dar pot căuta și accesorii potrivite pentru el.`;
  }

  const bundleTotal = bundleProducts.slice(0, 2).reduce((sum, p) => sum + p.price, mainProduct.price);
  const names = bundleProducts.slice(0, 2).map((p) => p.title).join(" + ");

  return `Bundle recomandat: ${mainProduct.title} + ${names}. Total estimat: ${Math.round(bundleTotal)} lei. Îl poți transforma într-un pachet mai complet în loc să iei doar un produs.`;
}
