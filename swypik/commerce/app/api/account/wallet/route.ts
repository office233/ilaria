import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { getWalletSnapshot } from "@/lib/wallet/read-model";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().regex(/^\d+$/).optional(),
});

export async function GET(req: Request): Promise<Response> {
  const user = await getAuthUser();
  if (!user.userId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "validation_error" }, { status: 400 });
  }
  try {
    const wallet = await getWalletSnapshot(user.userId, parsed.data);
    return NextResponse.json({ success: true, wallet });
  } catch (error) {
    logger.error({ err: error, userId: user.userId }, "[account/wallet] read failed");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
