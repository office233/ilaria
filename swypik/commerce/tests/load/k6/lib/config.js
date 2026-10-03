/**
 * Configurație comună pentru scenariile k6 (vezi docs/infra/load-testing.md).
 *
 * Variabile (`k6 run -e NUME=valoare ...`):
 *   BASE_URL        OBLIGATORIU. Ținta (staging). Producția e refuzată, fără excepții.
 *   PROFILE         smoke | load | stress (implicit smoke).
 *   MAX_VUS         Suprascrie vârful de VU-uri al profilului.
 *   TOLERATE_429    1 → 429 nu mai contează ca eșec (e urmărit în metrica `rate_limited`).
 *   EXPECT_CF       1 → pragul `edge_cache_hit` devine activ (doar în spatele Cloudflare).
 *   SESSION_COOKIE  Valoarea cookie-ului `swypik_session` al contului de test (doar staging).
 *   ALLOW_WRITES    1 → scenariile de scriere chiar trimit POST/PUT/DELETE.
 *
 * Validarea rulează la încărcarea modulului (faza init), deci k6 se oprește
 * înainte de orice cerere dacă BASE_URL lipsește sau indică producția.
 */

/** Gazde de producție — nu se testează NICIODATĂ, indiferent de alte flag-uri. */
export const FORBIDDEN_HOSTS = ["swypik.com", "www.swypik.com"];

/** Extrage host-ul (fără port, lowercase, fără punct final) dintr-un URL absolut http(s). */
export function hostOf(url) {
  const m = /^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(String(url || "").trim());
  return m ? m[1].toLowerCase().replace(/\.+$/, "") : null;
}

/** Aruncă eroare dacă ținta lipsește, nu e http(s) sau e producția. Returnează URL-ul fără `/` final. */
export function assertSafeBaseUrl(raw) {
  if (!raw) {
    throw new Error("BASE_URL lipsește. Rulează cu -e BASE_URL=https://<staging> (producția e interzisă).");
  }
  const host = hostOf(raw);
  if (!host) throw new Error(`BASE_URL invalid: "${raw}" (trebuie http:// sau https://).`);
  if (FORBIDDEN_HOSTS.indexOf(host) !== -1) {
    throw new Error(`BASE_URL indică producția (${host}). Testele de încărcare rulează doar pe staging.`);
  }
  return String(raw).trim().replace(/\/+$/, "");
}

export const BASE_URL = assertSafeBaseUrl(__ENV.BASE_URL);

export const PROFILE = (__ENV.PROFILE || "smoke").toLowerCase();
export const ALLOW_WRITES = __ENV.ALLOW_WRITES === "1";
export const TOLERATE_429 = __ENV.TOLERATE_429 === "1";
export const EXPECT_CF = __ENV.EXPECT_CF === "1";
export const SESSION_COOKIE = __ENV.SESSION_COOKIE || "";
export const SESSION_COOKIE_NAME = "swypik_session";

/** Profiluri de încărcare: `peak` = VU-uri la vârf, `stages` relative la vârf. */
const PROFILES = {
  smoke: { peak: 2, stages: [["30s", 1], ["1m", 1], ["10s", 0]] },
  load: { peak: 50, stages: [["2m", 0.5], ["5m", 1], ["2m", 1], ["1m", 0]] },
  stress: { peak: 200, stages: [["2m", 0.25], ["3m", 0.5], ["3m", 1], ["3m", 1], ["2m", 0]] },
};

export function stagesFor(profileName, maxVus) {
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new Error(`PROFILE necunoscut: "${profileName}". Valori: ${Object.keys(PROFILES).join(", ")}.`);
  }
  const peak = Number(maxVus) > 0 ? Math.floor(Number(maxVus)) : profile.peak;
  return profile.stages.map(([duration, ratio]) => ({
    duration,
    target: ratio === 0 ? 0 : Math.max(1, Math.round(peak * ratio)),
  }));
}

/**
 * Opțiunile k6 pentru un scenariu. `latency` = { p95, p99 } în ms, aplicate pe
 * cererile marcate cu tag-ul `name` (vezi lib/http.js). `extraThresholds` se
 * adaugă peste cele comune.
 */
export function buildOptions(latencyByName, extraThresholds) {
  const thresholds = {
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
  };
  for (const name of Object.keys(latencyByName)) {
    const { p95, p99 } = latencyByName[name];
    thresholds[`http_req_duration{name:${name}}`] = [`p(95)<${p95}`, `p(99)<${p99}`];
  }
  if (TOLERATE_429) thresholds.rate_limited = ["rate<0.20"];
  if (EXPECT_CF) thresholds.edge_cache_hit = ["rate>0.80"];
  return {
    stages: stagesFor(PROFILE, __ENV.MAX_VUS),
    thresholds: Object.assign(thresholds, extraThresholds || {}),
    summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
    userAgent: "swypik-k6-loadtest/1.0",
    // setup() poate face câteva cereri de descoperire/încălzire.
    setupTimeout: "60s",
  };
}

/** Listă de id-uri dintr-o variabilă CSV (`PRODUCT_IDS=a,b,c`). */
export function idsFromEnv(name) {
  return String(__ENV[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function requireWritesAllowed() {
  if (!ALLOW_WRITES) {
    throw new Error("Scenariul scrie date: rulează cu -e ALLOW_WRITES=1 (doar staging, cont de test).");
  }
  if (!SESSION_COOKIE) {
    throw new Error("Scenariul de scriere cere -e SESSION_COOKIE=<swypik_session al contului de test>.");
  }
}
