/**
 * Validare zod pentru parametri de rută / query (2026-09-26, w1-security).
 * Un id invalid trimis direct în SQL pe o coloană uuid/bigint dădea 500
 * (`invalid input syntax for type uuid`) — acum 400 (API) / 404 (pagini).
 */
import { z } from "zod";
import { NextResponse } from "next/server";
import { UUID_RE } from "@/lib/validation/uuid";

export const uuidParamSchema = z.string().regex(UUID_RE);
export const bigintIdParamSchema = z.string().regex(/^[1-9]\d{0,17}$/);

export function isUuidParam(value: unknown): value is string {
  return uuidParamSchema.safeParse(value).success;
}

export function isBigintIdParam(value: unknown): value is string {
  return bigintIdParamSchema.safeParse(value).success;
}

export function invalidIdResponse(): NextResponse {
  return NextResponse.json({ error: "invalid_id" }, { status: 400 });
}

/** Paginare standard: limit ∈ [1, max], offset ≥ 0; valori ne-numerice → eroare. */
export function paginationSchema(defaultLimit: number, maxLimit: number) {
  return z.object({
    limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  });
}

/** Extrage query params ca obiect (fără chei goale) pentru zod. */
export function queryObject(url: URL, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = url.searchParams.get(k);
    if (v !== null && v !== "") out[k] = v;
  }
  return out;
}

/** Coduri Postgres pentru input invalid (tip/format/interval). */
const PG_INVALID_INPUT_CODES = new Set(["22P02", "22003", "22007", "22008"]);

export function isPgInvalidInputError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && PG_INVALID_INPUT_CODES.has(code);
}
