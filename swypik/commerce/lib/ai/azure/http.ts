/**
 * Transport HTTP comun pentru Azure AI: timeout per încercare, retry pe 429/5xx
 * cu respectarea `Retry-After` / `retry-after-ms`, backoff exponențial cu jitter,
 * erori tipizate. Cheile nu apar niciodată în loguri sau în mesajele de eroare.
 */
import { logger } from "@/lib/logger";
import { azureLimits } from "./config";

export type AzureErrorCode =
  | "not_configured"
  | "rate_limited"
  | "http"
  | "timeout"
  | "network"
  | "content_filter"
  | "bad_response";

export class AzureAIError extends Error {
  readonly code: AzureErrorCode;
  readonly status?: number;
  constructor(code: AzureErrorCode, message: string, status?: number) {
    super(message);
    this.name = "AzureAIError";
    this.code = code;
    this.status = status;
  }
}

export type AzureRequest = {
  /** Etichetă pentru loguri/metrici (ex. "chat", "whisper", "safety.text"). */
  op: string;
  url: string;
  headers: Record<string, string>;
  body: BodyInit;
  timeoutMs: number;
  signal?: AbortSignal;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Așteptarea cerută de server (ms) sau null dacă nu e specificată. */
export function retryAfterMs(res: Response): number | null {
  const ms = Number(res.headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function backoffMs(attempt: number): number {
  return Math.min(4_000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
}

async function once(req: AzureRequest): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
  const onAbort = () => ctrl.abort();
  req.signal?.addEventListener("abort", onAbort);
  try {
    return await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) throw new AzureAIError("timeout", `${req.op}: timeout after ${req.timeoutMs}ms`);
    throw new AzureAIError("network", `${req.op}: ${err instanceof Error ? err.message : "network error"}`);
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
  }
}

async function errorFromResponse(op: string, res: Response): Promise<AzureAIError> {
  const text = await res.text().catch(() => "");
  if (res.status === 400 && /content_filter|ResponsibleAIPolicyViolation/i.test(text)) {
    return new AzureAIError("content_filter", `${op}: blocked by Azure content filter`, 400);
  }
  if (res.status === 429) return new AzureAIError("rate_limited", `${op}: rate limited`, 429);
  return new AzureAIError("http", `${op}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
}

/**
 * POST cu retry. Întoarce răspunsul 2xx; altfel aruncă AzureAIError.
 * Retry doar pe 408/429/5xx și pe erori de rețea/timeout.
 */
export async function azurePost(req: AzureRequest): Promise<Response> {
  const { maxAttempts, maxRetryWaitMs } = azureLimits();
  let lastError: AzureAIError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await once(req);
    } catch (err) {
      lastError = err instanceof AzureAIError ? err : new AzureAIError("network", `${req.op}: failed`);
      if (req.signal?.aborted || attempt === maxAttempts) break;
      await sleep(backoffMs(attempt));
      continue;
    }
    if (res.ok) return res;
    lastError = await errorFromResponse(req.op, res);
    if (!isRetryable(res.status) || attempt === maxAttempts) break;
    const wait = retryAfterMs(res) ?? backoffMs(attempt);
    if (wait > maxRetryWaitMs) break;
    logger.warn({ op: req.op, status: res.status, attempt, waitMs: wait }, "[azure-ai] retrying");
    await sleep(wait);
  }
  throw lastError ?? new AzureAIError("network", `${req.op}: failed`);
}
