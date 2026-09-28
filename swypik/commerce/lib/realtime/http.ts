/** Apel JSON autenticat (Bearer) către API-urile Cloudflare Realtime, cu timeout. */
import { realtimeHttpTimeoutMs } from "./config";

export class RealtimeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RealtimeApiError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH";

type ErrorShape = {
  errorCode?: string;
  errorDescription?: string;
  errors?: Array<{ code?: number | string; message?: string }>;
};

function describeError(status: number, body: unknown): { code: string; message: string } {
  const b = (body ?? {}) as ErrorShape;
  if (b.errorCode) return { code: b.errorCode, message: b.errorDescription ?? b.errorCode };
  const first = b.errors?.[0];
  if (first) return { code: String(first.code ?? status), message: first.message ?? `HTTP ${status}` };
  return { code: String(status), message: `HTTP ${status}` };
}

export async function realtimeFetch<T>(url: string, token: string, method: Method, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(realtimeHttpTimeoutMs()),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const { code, message } = describeError(res.status, json);
    throw new RealtimeApiError(res.status, code, message);
  }
  // SFU-ul raportează erorile și cu 200 (errorCode la nivel de răspuns).
  const maybe = (json ?? {}) as ErrorShape;
  if (maybe.errorCode) throw new RealtimeApiError(res.status, maybe.errorCode, maybe.errorDescription ?? maybe.errorCode);
  return json as T;
}
