/**
 * Fișierele de asociere app ↔ domeniu (Universal Links iOS, App Links Android),
 * construite DOAR din env — fără identificatori hardcodați. Fără configurare →
 * `null` → rutele /.well-known/* răspund 404 (nu un fișier gol/greșit, pe care
 * Apple/Google l-ar pune în cache ca „asociere invalidă”).
 *
 *   APPLE_TEAM_ID=ABCDE12345
 *   IOS_BUNDLE_IDS=com.swypik.app,com.swypik.courier
 *   ANDROID_APP_LINKS=com.swypik.app=AA:BB:…:FF|11:22:…:33;com.swypik.courier=…
 *     (pachet=amprente SHA-256 ale certificatului de semnare, separate prin |;
 *      aplicațiile separate prin ;)
 */

const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const SHA256_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** Rute care nu se deschid niciodată în aplicație (back-office, API). */
const EXCLUDED_PATHS = ["/api/*", "/admin/*", "/seller/*", "/courier/*", "/auth/*"];

type Env = Record<string, string | undefined>;

function list(raw: string | undefined, sep: string): string[] {
  return (raw ?? "")
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function appleAppSiteAssociation(env: Env = process.env) {
  const teamId = env.APPLE_TEAM_ID?.trim() ?? "";
  const bundles = list(env.IOS_BUNDLE_IDS, ",").filter((b) => BUNDLE_RE.test(b));
  if (!TEAM_ID_RE.test(teamId) || bundles.length === 0) return null;
  const appIDs = bundles.map((b) => `${teamId}.${b}`);
  return {
    applinks: {
      details: [
        {
          appIDs,
          components: [...EXCLUDED_PATHS.map((p) => ({ "/": p, exclude: true })), { "/": "*" }],
        },
      ],
    },
    webcredentials: { apps: appIDs },
  };
}

export function androidAssetLinks(env: Env = process.env) {
  const statements = list(env.ANDROID_APP_LINKS, ";")
    .map((entry) => {
      const eq = entry.indexOf("=");
      const pkg = (eq < 0 ? entry : entry.slice(0, eq)).trim();
      const prints = eq < 0 ? "" : entry.slice(eq + 1);
      const fingerprints = list(prints.toUpperCase(), "|").filter((f) => SHA256_RE.test(f));
      if (!PACKAGE_RE.test(pkg) || fingerprints.length === 0) return null;
      return {
        relation: [
          "delegate_permission/common.handle_all_urls",
          "delegate_permission/common.get_login_creds",
        ],
        target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: fingerprints },
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
  return statements.length ? statements : null;
}
