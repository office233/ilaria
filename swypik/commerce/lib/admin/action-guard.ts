/**
 * Gardă pentru server actions din consola de admin.
 *
 * Server actions sunt endpoint-uri POST invocabile direct — layout-ul /admin
 * nu le protejează. `assertAdminSession()` accepta ORICE rol de admin (ex.
 * support putea aproba selleri); aici se cere permisiunea minimă a acțiunii.
 *
 *   const actor = await assertAdminPermission("partners");
 */
import { getAdminActor, type AdminActor } from "@/lib/security/admin-auth";
import { hasPermission, type AdminPermission } from "./permissions";

export class AdminActionError extends Error {
  constructor(public readonly code: "unauthorized" | "forbidden") {
    super(code);
    this.name = "AdminActionError";
  }
}

export async function assertAdminPermission(permission: AdminPermission): Promise<AdminActor> {
  const actor = await getAdminActor();
  if (!actor) throw new AdminActionError("unauthorized");
  if (!hasPermission(actor.role, permission)) throw new AdminActionError("forbidden");
  return actor;
}
