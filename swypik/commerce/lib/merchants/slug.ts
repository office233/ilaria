/** Slug pentru local_merchants: fără diacritice, [a-z0-9-], max 70 + sufix unic. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

/** Slug unic (sufix bazat pe timp) pentru un comerciant nou. */
export function merchantSlug(name: string, now: number = Date.now()): string {
  return `${slugify(name) || "merchant"}-${now.toString(36).slice(-4)}`;
}
