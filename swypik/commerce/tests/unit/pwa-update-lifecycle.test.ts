import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("PWA service-worker deploy lifecycle", () => {
  it("versions the worker by the deterministic app build and bypasses HTTP cache", () => {
    const config = read("next.config.mjs");
    const registrar = read("components/pwa/ServiceWorkerRegistrar.tsx");

    expect(config).toContain("NEXT_PUBLIC_SW_VERSION");
    expect(config).toContain('source: "/sw.js"');
    expect(config).toContain("no-cache, no-store, must-revalidate");
    expect(registrar).toContain("/sw.js?v=");
    expect(registrar).toContain('updateViaCache: "none"');
    expect(registrar).toContain("registration.update()");
  });

  it("activates immediately and reloads an already-controlled page only once", () => {
    const sw = read("public/sw.js");
    const registrar = read("components/pwa/ServiceWorkerRegistrar.tsx");

    expect(sw).toContain("self.skipWaiting()");
    expect(sw).toContain("self.clients.claim()");
    expect(registrar).toContain('"controllerchange"');
    expect(registrar).toContain("hadController");
    expect(registrar).toContain("sessionStorage.setItem");
    expect(registrar).toContain("window.location.reload()");
  });
});
