/**
 * Pagina de produs: API-ul de detaliu + pagina localizată randată de server.
 *   GET /api/products/<id>      (JSON)
 *   GET /<LOCALE>/product/<id>  (HTML, implicit LOCALE=ro)
 * Id-urile: -e PRODUCT_IDS=id1,id2 sau descoperite din GET /api/products în setup.
 *   k6 run -e BASE_URL=https://staging.example -e PROFILE=smoke tests/load/k6/product-page.js
 */
import { check, sleep } from "k6";
import { buildOptions } from "./lib/config.js";
import { get, checkJson } from "./lib/http.js";
import { discoverProductIds, pick } from "./lib/discover.js";

const LOCALE = __ENV.LOCALE || "ro";

export const options = buildOptions({
  product_api: { p95: 600, p99: 1200 },
  product_page: { p95: 1500, p99: 3000 },
});

export function setup() {
  const ids = discoverProductIds(20);
  if (!ids.length) throw new Error("Niciun produs găsit: setează -e PRODUCT_IDS=... sau populează staging-ul.");
  return { ids };
}

export default function iteration(data) {
  const id = pick(data.ids);
  const api = get(`/api/products/${encodeURIComponent(id)}`, "product_api");
  checkJson(api, "product_api", (b) => Boolean(b.product || b.id));
  sleep(0.5);

  const page = get(`/${LOCALE}/product/${encodeURIComponent(id)}`, "product_page", {
    headers: { Accept: "text/html" },
  });
  check(page, {
    "product_page: status 200": (r) => r.status === 200,
    "product_page: HTML": (r) => String(r.headers["Content-Type"] || "").indexOf("text/html") !== -1,
  });
  sleep(1 + Math.random() * 2);
}
