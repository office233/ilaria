// Swypik — pagina de mentenanță (Cloudflare Worker), activă DOAR în fereastra
// de cutover. Răspunde 503 + Retry-After pe toate rutele: browserele văd pagina,
// Stripe/cron externe reîncearcă automat mai târziu (Stripe până la 3 zile).
// Deploy/ștergere: vezi docs/infra/azure-cutover.md (§ Cutover).

const RETRY_AFTER_SECONDS = "900";

const HTML = `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Swypik — mentenanță</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background: Canvas; color: CanvasText; padding: 24px; box-sizing: border-box; }
  main { max-width: 28rem; text-align: center; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
  p { margin: .25rem 0; opacity: .8; }
</style>
</head>
<body>
<main>
  <h1>Revenim în câteva minute</h1>
  <p>Mutăm Swypik pe o infrastructură nouă, mai rapidă. Datele tale sunt în siguranță.</p>
  <p lang="en">We're moving Swypik to new infrastructure. Back in a few minutes.</p>
</main>
</body>
</html>`;

export default {
  async fetch(request) {
    const accept = request.headers.get("accept") || "";
    const headers = {
      "retry-after": RETRY_AFTER_SECONDS,
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    };
    if (accept.includes("text/html")) {
      return new Response(HTML, { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
    }
    return new Response(JSON.stringify({ error: "maintenance", retry_after: Number(RETRY_AFTER_SECONDS) }), {
      status: 503,
      headers: { ...headers, "content-type": "application/json" },
    });
  },
};
