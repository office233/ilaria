/**
 * Logica pură de navigare (testată în tests/unit/nav-visibility.test.ts):
 * ce module vede un utilizator, unde e ascuns BottomNav, ce rute sunt imersive.
 */
import type { ClientFeatureName } from "@/lib/feature-flags-client";
import {
  BOTTOM_NAV,
  NAV_GROUPS,
  NAV_MODULES,
  type BottomNavKey,
  type NavGroup,
  type NavModule,
  type ViewerRole,
} from "./modules";

export type FlagReader = (flag: ClientFeatureName) => boolean;

/** `/go` se potrivește cu `/go` și `/go/x`, dar NU cu `/good`. `/` se potrivește doar exact. */
export function matchesRoute(pathname: string, route: string): boolean {
  const path = normalizePath(pathname);
  if (route === "/") return path === "/";
  return path === route || path.startsWith(`${route}/`);
}

function normalizePath(pathname: string): string {
  const noQuery = pathname.split(/[?#]/)[0] || "/";
  return noQuery.length > 1 && noQuery.endsWith("/") ? noQuery.slice(0, -1) : noQuery;
}

export function isModuleEnabled(module: NavModule, isEnabled: FlagReader): boolean {
  return module.flag ? isEnabled(module.flag) : true;
}

export function hasAnyRole(module: NavModule, roles: ReadonlySet<ViewerRole>): boolean {
  if (!module.roles || module.roles.length === 0) return true;
  if (roles.has("admin")) return true;
  return module.roles.some((r) => roles.has(r));
}

export type MenuEntry = { module: NavModule; mode: "open" | "become" };
export type MenuSection = { group: NavGroup; entries: MenuEntry[] };

/**
 * Secțiunile meniului pentru un utilizator: modulele cu flag OFF dispar; cele
 * cu rol lipsă devin CTA „Devino …” (dacă au `become`) sau dispar.
 * Grupurile goale nu sunt returnate.
 */
export function buildMenuSections(
  roles: ReadonlySet<ViewerRole>,
  isEnabled: FlagReader,
  modules: readonly NavModule[] = NAV_MODULES,
): MenuSection[] {
  const sections: MenuSection[] = [];
  for (const group of NAV_GROUPS) {
    const entries: MenuEntry[] = [];
    for (const mod of modules) {
      if (mod.group !== group || !isModuleEnabled(mod, isEnabled)) continue;
      if (hasAnyRole(mod, roles)) entries.push({ module: mod, mode: "open" });
      else if (mod.become) entries.push({ module: mod, mode: "become" });
    }
    if (entries.length > 0) sections.push({ group, entries });
  }
  return sections;
}

/** Modulele pentru EcosystemBar / grila Discover (fără restricții de rol). */
export function ecosystemModules(isEnabled: FlagReader, modules: readonly NavModule[] = NAV_MODULES): NavModule[] {
  return modules.filter((m) => m.ecosystem && !m.roles && isModuleEnabled(m, isEnabled));
}

/**
 * Zone unde BottomNav nu apare: portaluri „pro” (seller, creator, curier,
 * admin), fluxuri full-screen (checkout, înregistrare, player Movies/Music, Go).
 */
export const BOTTOM_NAV_HIDDEN_ROUTES: readonly string[] = [
  "/movies",
  "/music",
  "/go",
  "/checkout",
  "/reels/record",
  "/seller",
  "/sellers",
  "/creator",
  "/admin",
  "/auth",
  "/upload",
  "/product",
  "/courier",
  "/onboarding",
  // Ecranul de chat (/messages/<id>): compozitorul stă jos, fără BottomNav peste el.
  // `/messages` simplu doar redirecționează în /inbox.
  "/messages",
];

export function isBottomNavHidden(pathname: string): boolean {
  return BOTTOM_NAV_HIDDEN_ROUTES.some((route) => matchesRoute(pathname, route));
}

/** Rute afișate pe fundal întunecat: chrome-ul global (BottomNav) trece pe dark. */
// /reels/record (Creează) nu e aici: camera își pune singură fundalul imersiv,
// pașii editare/detalii sunt light-first (și BottomNav e ascuns acolo oricum).
export const IMMERSIVE_ROUTES: readonly string[] = ["/", "/explore", "/video", "/v", "/live"];

export function isImmersiveRoute(pathname: string): boolean {
  return IMMERSIVE_ROUTES.some((route) => matchesRoute(pathname, route));
}

/** Tab-ul activ din BottomNav pentru o cale (sau null). */
export function activeBottomNavKey(pathname: string): BottomNavKey | null {
  if (matchesRoute(pathname, "/") || matchesRoute(pathname, "/explore")) return "home";
  for (const item of BOTTOM_NAV) {
    if (item.route !== "/" && matchesRoute(pathname, item.route)) return item.key;
  }
  if (matchesRoute(pathname, "/messages") || matchesRoute(pathname, "/notifications")) return "inbox";
  if (matchesRoute(pathname, "/search") || matchesRoute(pathname, "/categories")) return "discover";
  return null;
}

type MeResponse = { role?: string | null; isAdmin?: boolean; sellerId?: string | null } | null;

/** Rolurile derivate din /api/auth/me (+ statusul de curier/partener de flotă/gazdă Stays). */
export function rolesFromViewer(
  me: MeResponse,
  extra: { courierApproved?: boolean; fleetApproved?: boolean; hostApproved?: boolean } = {},
): Set<ViewerRole> {
  const roles = new Set<ViewerRole>();
  if (!me) {
    roles.add("guest");
    return roles;
  }
  roles.add("shopper");
  if (me.role === "creator") roles.add("creator");
  if (me.role === "seller" || me.sellerId) roles.add("seller");
  if (me.role === "admin" || me.isAdmin) roles.add("admin");
  if (extra.courierApproved) roles.add("courier");
  if (extra.fleetApproved) roles.add("fleet");
  if (extra.hostApproved) roles.add("host");
  return roles;
}
