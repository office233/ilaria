/**
 * Aplicarea ca creator.
 *
 *   GET  /api/creator/apply → { state, application? }
 *        state: 'guest' | 'creator' | 'seller' | 'none' | 'pending' | 'rejected'
 *   POST /api/creator/apply { handle, category, links[] }
 *        → { state: 'pending', application } (NU schimbă rolul — adminul aprobă
 *          în /admin/applications; userul e anunțat in-app + email).
 *
 * O singură aplicare deschisă per user (index unic parțial, migrarea 0063):
 * repetarea cererii întoarce aplicarea existentă. Sellerii nu pot aplica cu
 * același cont (rolul e exclusiv); UI-ul le explică asta.
 */
import { NextResponse } from "next/server";
import { getCreatorUserId } from "@/lib/creator/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { creatorApplySchema, getApplicationState, submitApplication } from "@/lib/creator/application";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await getCreatorUserId();
  if (!userId) return NextResponse.json({ state: "guest" });
  try {
    return NextResponse.json(await getApplicationState(userId), { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    logger.error({ err }, "[creator/apply] GET failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await getCreatorUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = await rateLimit("creatorApply", userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(creatorApplySchema, await req.json().catch(() => null));
  if (!parsed.ok) {
    const field = String(parsed.issues[0]?.path[0] ?? "");
    return NextResponse.json({ error: "invalid_body", code: parsed.code, field }, { status: 400 });
  }

  try {
    const res = await submitApplication(userId, parsed.data);
    if (!res.ok) {
      const status = res.code === "not_found" ? 404 : res.code === "handle_taken" ? 409 : 403;
      return NextResponse.json({ error: res.code }, { status });
    }
    return NextResponse.json(res.state, { status: res.created ? 201 : 200 });
  } catch (err) {
    logger.error({ err }, "[creator/apply] POST failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
