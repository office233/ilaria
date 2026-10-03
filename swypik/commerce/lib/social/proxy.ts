import { logger } from "@/lib/logger";

export function getSocialApiBaseUrl() {
  const raw =
    process.env.SOCIAL_API_URL ||
    process.env.GO_API_URL ||
    process.env.NEXT_PUBLIC_SOCIAL_API_URL;

  if (!raw) return null;
  const base = raw
    .replace(/\/api\/v1\/videos\/upload\/?$/, "")
    .replace(/\/v1\/videos\/upload\/?$/, "");
  return base.endsWith("/") ? base : `${base}/`;
}

export async function proxyToSocialApi(req: Request, path: string) {
  const baseUrl = getSocialApiBaseUrl();
  if (!baseUrl) return null;

  const incomingUrl = new URL(req.url);
  const upstreamUrl = new URL(path.replace(/^\//, ""), baseUrl);
  upstreamUrl.search = incomingUrl.search;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("connection");
  // Secretul intern nu poate veni NICIODATA de la client: altfel, cand
  // PLATFORM_API_SECRET nu e setat, apelantul si-l injecteaza singur si trece
  // drept apel intern in platform-api.
  headers.delete("x-swypik-internal-secret");
  if (process.env.PLATFORM_API_SECRET) {
    headers.set("X-Swypik-Internal-Secret", process.env.PLATFORM_API_SECRET);
  }

  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();

  // 2026-08-24 (audit perf): fără plafon, o instanță platform-api lentă ținea
  // cererea (și conexiunea pg aferentă) ocupată până la timeout-ul implicit al
  // runtime-ului — o singură dependență degradată se propaga în tot serverul.
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(
        Number(process.env.PLATFORM_API_TIMEOUT_MS) > 0
          ? Math.trunc(Number(process.env.PLATFORM_API_TIMEOUT_MS))
          : 10_000,
      ),
    });
  } catch (err) {
    // 2026-09-24: fără acest catch, un abort de timeout ajungea la handler-ul
    // generic de erori ca "[Error [TimeoutError]: The operation was aborted
    // due to timeout]" — fără nicio urmă a cui e upstream-ul care a picat.
    logger.warn({ err, upstream: upstreamUrl.toString() }, "[social-proxy] platform-api fetch failed or timed out");
    throw err;
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.set("x-Swypik-upstream", "go-social-api");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
