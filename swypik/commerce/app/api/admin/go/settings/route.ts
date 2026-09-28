/**
 * GET/PATCH /api/admin/go/settings — setările Swypik Go (cash/card, grația de
 * anulare, plafonul tarifului, TTL-ul autorizării, documente obligatorii).
 * Fiecare modificare e scrisă în admin_audit_log (valori vechi + noi).
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/security/admin-audit";
import { getGoSettings, updateGoSettings, GoSettingsPatchSchema } from "@/lib/rides/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const actor = await requireAdmin(req, "mobility");
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json({ settings: await getGoSettings() });
}

export async function PATCH(req: Request) {
  const actor = await requireAdmin(req, "mobility");
  if (actor instanceof NextResponse) return actor;
  const parsed = GoSettingsPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const before = await getGoSettings();
  const settings = await updateGoSettings(parsed.data);
  const keys = Object.keys(parsed.data) as (keyof typeof parsed.data)[];
  await logAdminAction({
        actor,
    action: "go.settings_update",
    targetType: "go_settings",
    targetId: 1,
    details: Object.fromEntries(keys.map((k) => [k, { from: before[k], to: settings[k] }])),
    req,
  });
  return NextResponse.json({ settings });
}
