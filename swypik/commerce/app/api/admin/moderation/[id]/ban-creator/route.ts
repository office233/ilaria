/**
 * POST /api/admin/moderation/[id]/ban-creator — body { note? }. Logica: lib/admin/moderation/report-actions.ts.
 */
import { reportActionRoute } from "@/lib/admin/moderation/report-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = reportActionRoute("ban_creator");
