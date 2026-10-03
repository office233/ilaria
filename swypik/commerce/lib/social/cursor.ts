/**
 * Cursor opac pentru paginare keyset pe (timestamp, id): base64url("<iso>|<uuid>").
 * Un cursor invalid → null (apelantul pornește de la început sau răspunde 400).
 */
import { UUID_RE } from "@/lib/validation/uuid";

export type Cursor = { at: string; id: string };

function toIso(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function encodeCursor(at: unknown, id: string): string | null {
  const iso = toIso(at);
  if (!iso || !UUID_RE.test(id)) return null;
  return Buffer.from(`${iso}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw || raw.length > 200) return null;
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [at, id, ...rest] = text.split("|");
  if (rest.length > 0 || !id || !UUID_RE.test(id)) return null;
  const iso = toIso(at);
  return iso ? { at: iso, id } : null;
}

/** Cursorul următoarei pagini: ultimul rând, doar dacă am primit o pagină plină (+1). */
export function nextCursorFrom<T extends { id: string }>(
  rows: T[],
  limit: number,
  at: (row: T) => unknown,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(at(last), last.id) : null };
}

/** Limită de pagină din query: întreg în [1, max], altfel valoarea implicită. */
export function pageLimit(raw: string | null, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}
