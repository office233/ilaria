/**
 * RBAC pentru consola de admin. Pur (fără I/O) — folosit de server (gărzi pe
 * rute/pagini) și de client (ascunderea intrărilor din meniu).
 *
 * Roluri (users.admin_role, migrarea 20260926_0100):
 *   owner     — tot, inclusiv acordarea/retragerea rolurilor de admin
 *   ops       — operațiuni zilnice: comenzi, parteneri, mobilitate, conținut, moderare
 *   finance   — bani: plăți, rambursări, dispute, comisioane
 *   moderator — coada de moderare, clipuri, recenzii, utilizatori (suspendare)
 *   support   — citire + suspendare utilizatori; fără bani, fără conținut
 */

export const ADMIN_ROLES = ["owner", "ops", "finance", "moderator", "support"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_PERMISSIONS = [
  "dashboard",
  "audit",
  "system",
  "users.manage",
  "admins.manage",
  "moderation",
  "content",
  "commerce",
  "partners",
  "mobility",
  "finance",
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  owner: ADMIN_PERMISSIONS,
  ops: ["dashboard", "audit", "system", "users.manage", "moderation", "content", "commerce", "partners", "mobility"],
  finance: ["dashboard", "audit", "commerce", "finance"],
  moderator: ["dashboard", "users.manage", "moderation", "content"],
  support: ["dashboard", "users.manage", "commerce"],
};

/**
 * Scripturile/cron-urile cu `Bearer ADMIN_SECRET` pot tot ce pot adminii,
 * CU EXCEPȚIA acordării de roluri de admin: un secret scurs nu mai poate
 * crea administratori permanenți.
 */
const MACHINE_PERMISSIONS: readonly AdminPermission[] = ADMIN_PERMISSIONS.filter((p) => p !== "admins.manage");

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" && (ADMIN_ROLES as readonly string[]).includes(value);
}

/** Rol necunoscut/NULL (admin creat înainte de migrare) = cel mai restrâns. */
export function normalizeAdminRole(value: unknown): AdminRole {
  return isAdminRole(value) ? value : "support";
}

export function permissionsFor(role: AdminRole | "machine"): readonly AdminPermission[] {
  return role === "machine" ? MACHINE_PERMISSIONS : ROLE_PERMISSIONS[role];
}

export function hasPermission(role: AdminRole | "machine", permission: AdminPermission): boolean {
  return permissionsFor(role).includes(permission);
}
