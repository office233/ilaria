import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { getAuthSession } from "@/lib/auth/session";
import { listHostProducts } from "@/lib/live/queries";

export const dynamic = "force-dynamic";

/** GET /api/live/host-products — produsele proprii pe care gazda le poate prezenta în live. */
async function GET_impl() {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const items = await listHostProducts(session.userId);
  return NextResponse.json({ items });
}

export const GET = withErrorHandling(GET_impl);
