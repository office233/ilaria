/** Răspunsuri comune pentru rutele de upload/publicare video. */
import { NextResponse } from "next/server";
import type { ZodTypeAny, z } from "zod";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireVideoAuthor, type VideoAuthor } from "@/lib/video/auth";
import { isUuid } from "@/lib/video/upload-session";

export function jsonError(status: number, code: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: code, code, ...extra }, { status });
}

/** Mapează erorile de domeniu (UploadInputError, erori cu `status`) la JSON cu `code`. */
export function errorResponse(err: unknown, context: string) {
  const e = err as { status?: unknown; code?: unknown; missing?: unknown };
  const status = typeof e?.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status >= 500 && status !== 503) {
    logger.error({ err }, `[video-upload] ${context} failed`);
    return jsonError(500, "internal_error");
  }
  const code = typeof e?.code === "string" ? e.code : "error";
  return jsonError(status, code, Array.isArray(e?.missing) ? { missing: e.missing } : {});
}

type Guarded = { ok: true; author: VideoAuthor } | { ok: false; response: NextResponse };

/** Autentificare + rol + rate limit pentru rutele care modifică stare. */
export async function guardAuthor(limitKey?: "uploadSession" | "uploadParts" | "creatorVideoEdit"): Promise<Guarded> {
  const auth = await requireVideoAuthor();
  if (!auth.ok) return { ok: false, response: jsonError(auth.status, auth.error) };
  if (limitKey) {
    const rl = await rateLimit(limitKey, auth.author.userId);
    if (!rl.success) return { ok: false, response: jsonError(429, "rate_limited") };
  }
  return { ok: true, author: auth.author };
}

export async function readJson<T extends ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  const body = await req.json().catch(() => undefined);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    return { ok: false, response: jsonError(400, "validation_error", { issues: parsed.error.issues.slice(0, 5) }) };
  }
  return { ok: true, data: parsed.data };
}

export function validId(id: string | undefined): id is string {
  return typeof id === "string" && isUuid(id);
}
