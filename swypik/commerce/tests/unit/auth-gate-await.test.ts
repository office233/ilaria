import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Regresie pentru breșa din 2026-08: poarta de admin era ocolită complet pe
 * trei rute care scriau
 *
 *     const ok = (await hasAdminSession()) || isAdminRequest(req);
 *     if (!ok) return 403;
 *
 * `isAdminRequest` este `async`, deci al doilea operand e un `Promise`, iar un
 * `Promise` e ÎNTOTDEAUNA truthy. Când prima verificare pica, `ok` devenea
 * obiectul Promise și `!ok` era mereu `false` — 403-ul nu se declanșa niciodată.
 * Oricine putea aproba/bloca fraudă pe comenzi, bloca utilizatori, și citi 90 de
 * zile de date de risc (adrese, IP-uri).
 *
 * Bug-ul trece de `tsc` (expresia e validă TypeScript) și de `next lint`
 * (regulile care l-ar prinde — no-misused-promises / no-floating-promises — cer
 * lint type-aware, care nu e activat aici). Testul ăsta e garda care rămâne.
 */

const APP_DIR = join(__dirname, "..", "..", "app");

/** Funcții `async` folosite ca poartă de autorizare. Apelate fără `await` returnează un Promise truthy. */
const ASYNC_AUTH_GATES = [
  "isAdminRequest",
  "hasAdminSession",
  "getAuthUser",
  "requireRole",
  "getOptionalSocialUserId",
  "getAuthSession",
  "suspensionGuard",
  // Consola de admin (sesiuni per administrator, 2026-09-26)
  "requireAdmin",
  "requireAdminPage",
  "getAdminActor",
  "getAdminActorFromRequest",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * Caută apeluri la o poartă async folosite ca OPERAND BOOLEAN fără `await` —
 * singurul context în care Promise-ul truthy schimbă decizia.
 *
 * NU semnalează formele corecte, unde Promise-ul e consumat mai încolo:
 *   - `return gate();`                      (apelantul face await)
 *   - `await Promise.all([gate(), ...])`    (await pe rezultatul combinat)
 *   - `const p = gate(); ... await p;`      (await amânat)
 * Auditul anterior a raportat prima formă ca breșă; era alarmă falsă.
 */
function findUnawaitedGates(source: string, gate: string): string[] {
  const hits: string[] = [];
  const lines = source.split("\n");

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("import") || trimmed.startsWith("*") || trimmed.startsWith("//")) return;
    if (new RegExp(`(export\\s+)?(async\\s+)?function\\s+${gate}\\b`).test(trimmed)) return;

    const callRe = new RegExp(`\\b${gate}\\s*\\(`, "g");
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(line)) !== null) {
      const before = line.slice(0, m.index);
      if (/await\s*$/.test(before)) continue;

      // Doar contextul boolean: `|| gate(`, `&& gate(`, `!gate(`, `if (gate(`.
      const booleanContext = /(\|\||&&|!|\bif\s*\(|\bwhile\s*\()\s*\(?\s*$/.test(before);
      if (!booleanContext) continue;

      hits.push(`linia ${i + 1}: ${trimmed}`);
    }
  });

  return hits;
}

describe("detectorul însuși", () => {
  it("PRINDE exact forma care a produs breșa", () => {
    const bug = "  const ok = (await hasAdminSession()) || isAdminRequest(req);";
    expect(findUnawaitedGates(bug, "isAdminRequest")).toHaveLength(1);
  });

  it("prinde și `!gate(` și `if (gate(`", () => {
    expect(findUnawaitedGates("if (!isAdminRequest(req)) return;", "isAdminRequest")).toHaveLength(1);
    expect(findUnawaitedGates("if (isAdminRequest(req)) next();", "isAdminRequest")).toHaveLength(1);
  });

  it("NU semnalează formele corecte (alarmele false ale auditului anterior)", () => {
    expect(findUnawaitedGates("  return getOptionalSocialUserId();", "getOptionalSocialUserId")).toEqual([]);
    expect(findUnawaitedGates("const [a, b] = await Promise.all([getAuthSession(), x()]);", "getAuthSession")).toEqual([]);
    expect(findUnawaitedGates("const ok = (await hasAdminSession()) || (await isAdminRequest(req));", "isAdminRequest")).toEqual([]);
    expect(findUnawaitedGates("if (!(await isAdminRequest(req))) return;", "isAdminRequest")).toEqual([]);
  });
});

describe("porțile de autorizare async sunt întotdeauna await-uite", () => {
  const files = walk(APP_DIR);
  // Citite o singură dată (înainte: o dată per poartă → timeout pe mașini încărcate).
  const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")] as const));

  it("găsește fișiere de scanat (testul nu trece degeaba)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const gate of ASYNC_AUTH_GATES) {
    it(`niciun apel la ${gate}() fără await`, () => {
      const offenders: string[] = [];

      for (const file of files) {
        const source = sources.get(file) ?? "";
        if (!source.includes(gate)) continue;
        const hits = findUnawaitedGates(source, gate);
        if (hits.length) {
          const rel = relative(APP_DIR, file).split(sep).join("/");
          offenders.push(`app/${rel}\n    ${hits.join("\n    ")}`);
        }
      }

      expect(
        offenders,
        `${gate}() este async — apelat fără await returnează un Promise, care e mereu truthy.\n` +
          `Într-o poartă de autorizare asta înseamnă că poarta nu blochează niciodată.\n` +
          `Scrie \`await ${gate}(...)\`.\n\n` +
          offenders.join("\n\n"),
      ).toEqual([]);
    });
  }
});
