import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ClientFeatureName } from "@/lib/feature-flags-client";
import { BOTTOM_NAV, LEGAL_LINKS, NAV_GROUPS, NAV_MODULES, type ViewerRole } from "@/lib/nav/modules";
import {
  activeBottomNavKey,
  buildMenuSections,
  ecosystemModules,
  isBottomNavHidden,
  isImmersiveRoute,
  matchesRoute,
  rolesFromViewer,
} from "@/lib/nav/visibility";

const allOn = () => true;
const onlyOff = (...off: ClientFeatureName[]) => (f: ClientFeatureName) => !off.includes(f);
const roles = (...r: ViewerRole[]) => new Set<ViewerRole>(r);
const ids = (sections: ReturnType<typeof buildMenuSections>) =>
  sections.flatMap((s) => s.entries.map((e) => `${e.module.id}:${e.mode}`));

describe("matchesRoute", () => {
  it("potrivește segmente întregi, nu prefixe de text", () => {
    expect(matchesRoute("/go", "/go")).toBe(true);
    expect(matchesRoute("/go/ride/1", "/go")).toBe(true);
    expect(matchesRoute("/good", "/go")).toBe(false);
    expect(matchesRoute("/go/", "/go")).toBe(true);
    expect(matchesRoute("/go?x=1", "/go")).toBe(true);
  });
  it("„/” se potrivește doar exact", () => {
    expect(matchesRoute("/", "/")).toBe(true);
    expect(matchesRoute("/shop", "/")).toBe(false);
  });
});

describe("buildMenuSections", () => {
  it("ascunde modulele cu flag OFF (nu le afișează gri)", () => {
    const on = ids(buildMenuSections(roles("shopper"), allOn));
    expect(on).toContain("movies:open");
    const off = ids(buildMenuSections(roles("shopper"), onlyOff("movies", "food")));
    expect(off).not.toContain("movies:open");
    expect(off).not.toContain("food:open");
  });

  it("nu conține niciodată Squad Buy, App Store/Developers sau Cares", () => {
    const all = ids(buildMenuSections(roles("admin"), allOn));
    for (const banned of ["squad", "apps", "developers", "cares"]) {
      expect(all.some((x) => x.startsWith(`${banned}:`))).toBe(false);
    }
    for (const m of NAV_MODULES) expect(m.route).not.toMatch(/^\/(squad|apps|developers|cares|cauze)\b/);
  });

  it("pentru roluri lipsă arată CTA „Devino …”, iar Admin doar adminilor", () => {
    const shopper = ids(buildMenuSections(roles("shopper"), allOn));
    expect(shopper).toContain("seller:become");
    expect(shopper).toContain("creator:become");
    expect(shopper).toContain("courier:become");
    expect(shopper).not.toContain("admin:open");
    expect(shopper.some((x) => x.startsWith("admin:"))).toBe(false);

    const seller = ids(buildMenuSections(roles("shopper", "seller"), allOn));
    expect(seller).toContain("seller:open");
    expect(seller).toContain("creator:become");

    const admin = ids(buildMenuSections(roles("shopper", "admin"), allOn));
    expect(admin).toContain("admin:open");
    expect(admin).toContain("seller:open");
  });

  it("păstrează ordinea grupurilor și omite grupurile goale", () => {
    const sections = buildMenuSections(roles("guest"), allOn);
    const order = sections.map((s) => NAV_GROUPS.indexOf(s.group));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const noEntertainment = buildMenuSections(roles("guest"), onlyOff("movies", "music", "gaming", "news"));
    expect(noEntertainment.some((s) => s.group === "entertainment")).toBe(false);
  });
});

describe("ecosystemModules", () => {
  it("doar module ecosistem, fără portaluri de rol, respectând flag-urile", () => {
    const mods = ecosystemModules(onlyOff("gaming"));
    expect(mods.map((m) => m.id)).toContain("food");
    expect(mods.map((m) => m.id)).not.toContain("gaming");
    expect(mods.every((m) => !m.roles)).toBe(true);
  });
});

describe("BottomNav routing", () => {
  it("e ascuns în portalurile pro și fluxurile full-screen", () => {
    for (const p of ["/seller", "/seller/orders", "/admin", "/checkout", "/reels/record", "/movies/x", "/courier"]) {
      expect(isBottomNavHidden(p)).toBe(true);
    }
    for (const p of ["/", "/discover", "/shop", "/account", "/good", "/reels"]) {
      expect(isBottomNavHidden(p)).toBe(false);
    }
  });

  it("feed-ul (home, explore) e imersiv; paginile de comerț și crearea nu", () => {
    expect(isImmersiveRoute("/reels/record")).toBe(false);
    expect(isImmersiveRoute("/")).toBe(true);
    expect(isImmersiveRoute("/explore")).toBe(true);
    expect(isImmersiveRoute("/shop")).toBe(false);
    expect(isImmersiveRoute("/videos-x")).toBe(false);
  });

  it("tab-ul activ", () => {
    expect(activeBottomNavKey("/")).toBe("home");
    expect(activeBottomNavKey("/explore")).toBe("home");
    expect(activeBottomNavKey("/discover")).toBe("discover");
    expect(activeBottomNavKey("/search")).toBe("discover");
    expect(activeBottomNavKey("/inbox")).toBe("inbox");
    expect(activeBottomNavKey("/notifications")).toBe("inbox");
    expect(activeBottomNavKey("/account/edit")).toBe("profile");
    expect(activeBottomNavKey("/shop")).toBeNull();
  });

  it("are exact Home · Discover · Create · Inbox · Profile", () => {
    expect(BOTTOM_NAV.map((i) => i.key)).toEqual(["home", "discover", "create", "inbox", "profile"]);
  });
});

describe("rolesFromViewer", () => {
  it("guest fără sesiune", () => {
    expect([...rolesFromViewer(null)]).toEqual(["guest"]);
  });
  it("derivă seller/admin/courier/fleet", () => {
    const r = rolesFromViewer({ role: "shopper", sellerId: "s1", isAdmin: true }, { courierApproved: true, fleetApproved: false });
    expect(r.has("seller")).toBe(true);
    expect(r.has("admin")).toBe(true);
    expect(r.has("courier")).toBe(true);
    expect(r.has("fleet")).toBe(false);
    expect(r.has("guest")).toBe(false);
  });
});

describe("registry ↔ traduceri", () => {
  const LOCALES = ["ro", "en", "es", "fr", "de", "pt", "it"];
  const messages = Object.fromEntries(
    LOCALES.map((l) => [l, JSON.parse(readFileSync(resolve(__dirname, `../../messages/${l}.json`), "utf8"))]),
  );

  it("id-uri unice", () => {
    const idList = NAV_MODULES.map((m) => m.id);
    expect(new Set(idList).size).toBe(idList.length);
  });

  it.each(LOCALES)("%s: fiecare etichetă de navigare există", (l) => {
    const m = messages[l];
    for (const mod of NAV_MODULES) {
      expect(m.appMenu.items[mod.labelKey], `${l} appMenu.items.${mod.labelKey}`).toBeTruthy();
      if (mod.become) expect(m.appMenu.become[mod.become.labelKey], `${l} become.${mod.become.labelKey}`).toBeTruthy();
    }
    for (const g of NAV_GROUPS) expect(m.appMenu.groups[g], `${l} groups.${g}`).toBeTruthy();
    for (const item of BOTTOM_NAV) expect(m.nav[item.key], `${l} nav.${item.key}`).toBeTruthy();
    for (const link of LEGAL_LINKS) expect(m.appMenu.legal[link.key], `${l} legal.${link.key}`).toBeTruthy();
  });
});
