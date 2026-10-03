/**
 * Picks the message to show for a failed API call.
 *
 * `parseBody()` (lib/validation/schemas.ts) puts the first zod issue message in
 * `error` — mostly Romanian — and tags it with `code: "validation_error"`. That
 * text is only safe to show as-is for the `ro` locale; everywhere else the
 * caller's translated fallback wins. Non-validation errors keep the previous
 * behaviour (raw `error` when present). Mirrors MenuClient.placeOrder
 * (audit 2026-09-24).
 */
export function apiErrorMessage(data: unknown, locale: string, fallback: string): string {
  const body = data && typeof data === "object" ? (data as { error?: unknown; code?: unknown }) : null;
  const raw = typeof body?.error === "string" && body.error.trim() ? body.error : null;
  if (!raw) return fallback;
  if (body?.code === "validation_error" && locale !== "ro") return fallback;
  return raw;
}
