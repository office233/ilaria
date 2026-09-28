/**
 * POST /api/merchants/[id]/suggest — „Sugerează proprietarului”.
 * Pentru profilurile nerevendicate (listing_mode = 'suggest_only'); un vot
 * per user/IP, rate-limitat. Întoarce contorul curent.
 */
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { getClientIP, rateLimit } from "@/lib/security/rate-limit";
import { logger } from "@/lib/logger";
import { FOOD_RATE_LIMITS } from "@/lib/food/config";
import { suggestMerchant, suggesterKey } from "@/lib/food/suggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ success: false, error: "invalid_id", code: "invalid_id" }, { status: 400 });
    }
    const session = await getAuthSession();
    const userId = session?.userId ?? null;
    const ip = getClientIP(req);
    const key = suggesterKey(userId, ip && ip !== "unknown" ? ip : null);
    if (!key) {
      return NextResponse.json({ success: false, error: "unauthorized", code: "unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("foodSuggest", key, FOOD_RATE_LIMITS.suggest);
    if (!rl.success) {
      return NextResponse.json({ success: false, error: "rate_limited", code: "rate_limited" }, { status: 429 });
    }

    const r = await suggestMerchant(id, key, userId);
    if (!r.ok) {
      return NextResponse.json({ success: false, error: r.code, code: r.code }, { status: r.code === "not_found" ? 404 : 409 });
    }
    return NextResponse.json({ success: true, counted: r.counted, suggestion_count: r.count });
  } catch (error: unknown) {
    logger.error({ err: error }, "[merchants/suggest] POST error");
    return NextResponse.json({ success: false, error: "server_error", code: "server_error" }, { status: 500 });
  }
}
