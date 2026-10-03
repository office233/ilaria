/** Apel JSON către API-ul panoului seller-ului; eroarea e codul stabil din răspuns. */
export type SellerApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export async function sellerApi<T = Record<string, unknown>>(
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<SellerApiResult<T>> {
  try {
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      cache: "no-store",
      headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: unknown };
    if (!res.ok) return { ok: false, status: res.status, error: typeof json.error === "string" ? json.error : "server_error" };
    return { ok: true, data: json };
  } catch {
    return { ok: false, status: 0, error: "network_error" };
  }
}

/** Cheia i18n pentru un cod de eroare (necunoscut → generic). */
export function sellerErrorKey(code: string, known: readonly string[]): string {
  return known.includes(code) ? `errors.${code}` : "errors.generic";
}
