import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import {
  deleteCatalogConnection,
  getCatalogConnection,
} from "@/lib/seller/imports/connections";
import { removeIntegrationWebhooks } from "@/lib/seller/imports/webhooks";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuidParam(id)) return invalidIdResponse();

  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const rl = await rateLimit("sellerIntegrations", sellerId);
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  try {
    const connection = await getCatalogConnection(sellerId, id);
    if (!connection) {
      return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
    }
    await removeIntegrationWebhooks(connection).catch((error) =>
      logger.warn(
        { err: error, sellerId, integrationId: id },
        "[seller/integrations/:id] remote webhook cleanup failed; deleting local credentials",
      ),
    );
    const deleted = await deleteCatalogConnection(sellerId, id);
    return deleted
      ? NextResponse.json({ success: true })
      : NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
  } catch (error) {
    logger.error(
      { err: error, sellerId, integrationId: id },
      "[seller/integrations/:id] disconnect failed",
    );
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
