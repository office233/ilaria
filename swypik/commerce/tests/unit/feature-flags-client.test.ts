import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Gardă de regresie: Next inlinează în bundle-ul de browser doar accesările
 * literale `process.env.NEXT_PUBLIC_X`. O căutare dinamică (`process.env[name]`)
 * lasă toate flag-urile client pe `false` în producție, oricare ar fi env-ul —
 * exact bug-ul care a ținut Movies/Music ascunse din meniu (2026-09-22).
 */
describe("feature-flags-client", () => {
  const src = readFileSync(resolve(__dirname, "../../lib/feature-flags-client.ts"), "utf8");
  it("citește flag-urile doar prin accesări literale process.env.NEXT_PUBLIC_*", () => {
    expect(src).not.toMatch(/process\.env\[/);
    for (const name of ["NEXT_PUBLIC_FEATURE_MOVIES", "NEXT_PUBLIC_FEATURE_MUSIC", "NEXT_PUBLIC_FEATURE_CARES"]) {
      expect(src).toContain(`process.env.${name}`);
    }
  });
  it("fiecare flag client are ARG + ENV în build-ul web-next din compose (altfel nu ajunge în bundle)", () => {
    const compose = readFileSync(resolve(__dirname, "../../infra/hetzner/docker-compose.prod.yml"), "utf8");
    for (const name of ["NEXT_PUBLIC_FEATURE_MOVIES", "NEXT_PUBLIC_FEATURE_MUSIC", "FEATURE_MOVIES", "FEATURE_MUSIC"]) {
      expect(compose).toMatch(new RegExp(`^\\s*${name}: \\$\\{${name}:-`, "m"));
      expect(compose).toMatch(new RegExp(`^\\s*ARG ${name}\\s*$`, "m"));
      expect(compose).toMatch(new RegExp(`^\\s*ENV ${name}=\\$${name}\\s*$`, "m"));
    }
  });
});
