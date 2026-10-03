/**
 * Taxonomia bucătăriilor (sursa: ./cuisines.json, citită și de scriptul de import OSM).
 *
 * Datele vechi conțin atât id-uri românești din import (`romaneasca`, `asiatica`)
 * cât și englezești din chip-uri (`romanian`, `asian`). Filtrul din API caută
 * după TOATE aliasurile unui id canonic, deci funcționează și înainte de
 * migrarea de normalizare (20260926_0033).
 */
import data from "./cuisines.json";

export type CuisineDef = { id: string; chip: boolean; aliases: string[] };

export const CUISINES: readonly CuisineDef[] = data.cuisines;

/** Id-urile afișate ca chip-uri de filtrare în /food. */
export const CUISINE_CHIP_IDS: readonly string[] = CUISINES.filter((c) => c.chip).map((c) => c.id);

const byId = new Map(CUISINES.map((c) => [c.id, c]));
const byAlias = new Map<string, string>();
for (const c of CUISINES) {
  byAlias.set(c.id, c.id);
  for (const a of c.aliases) byAlias.set(a.toLowerCase(), c.id);
}

export function isCuisineId(id: string): boolean {
  return byId.has(id);
}

/** Id-ul canonic pentru o etichetă brută (alias necunoscut → null). */
export function canonicalCuisine(raw: string): string | null {
  const k = raw.trim().toLowerCase();
  return byAlias.get(k) ?? byAlias.get(k.replace(/\s+/g, "_")) ?? null;
}

/** Toate valorile din DB care înseamnă același id canonic (pentru `&&` în SQL). */
export function cuisineMatchValues(id: string): string[] {
  const def = byId.get(id);
  if (!def) return [];
  return Array.from(new Set([def.id, ...def.aliases]));
}

/** Normalizează lista unui comerciant: id-uri canonice, fără duplicate. */
export function normalizeCuisines(list: readonly string[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const raw of list ?? []) {
    const c = canonicalCuisine(raw);
    if (c) out.add(c);
  }
  return Array.from(out);
}
