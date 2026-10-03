/**
 * Gărzi unice pentru consola de admin: rute API și pagini server.
 *
 *   const actor = await requireAdmin(req, "moderation");
 *   if (actor instanceof NextResponse) return actor;
 */
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import {
  getAdminActor,
  getAdminActorFromRequest,
  type AdminActor,
} from "@/lib/security/admin-auth";
import { hasPermission, type AdminPermission } from "./permissions";

export type { AdminActor };

export async function requireAdmin(
  req: Request,
  permission: AdminPermission,
): Promise<AdminActor | NextResponse> {
  const actor = await getAdminActorFromRequest(req);
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(actor.role, permission)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return actor;
}

/**
 * Pentru pagini server: fără sesiune → /admin (layout-ul arată login-ul);
 * fără permisiune → null (pagina afișează <AdminForbidden />).
 */
export async function requireAdminPage(permission: AdminPermission): Promise<AdminActor | null> {
  const actor = await getAdminActor();
  if (!actor) redirect("/admin");
  return hasPermission(actor.role, permission) ? actor : null;
}
