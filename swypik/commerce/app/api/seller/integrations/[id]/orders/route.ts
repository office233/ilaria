import { NextResponse } from "next/server";
import { z } from "zod";
import { withAdvisoryLock } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import {
  getCatalogConnection,
  markOrderSyncFailure,
  markOrderSyncSuccess,
} from "@/lib/seller/imports/connections";
import { CatalogProviderError } from "@/lib/seller/imports/common";
import { fetchOrderPage } from "@/lib/seller/imports/provider";
import { syncOrderPage } from "@/lib/seller/imports/orders";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const SyncSchema = z.object({
  cursor: z.string().trim().max(2048).nullable().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
}).strict();

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuidParam(id)) return invalidIdResponse();

  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const rl = await rateLimit("sellerOrderImport", sellerId);
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  const parsed = SyncSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "validation_error" }, { status: 400 });
  }

  const connection = await getCatalogConnection(sellerId, id);
  if (!connection) {
    return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
  }
  if (connection.status === "disabled") {
    return NextResponse.json({ success: false, error: "integration_disabled" }, { status: 409 });
  }

  try {
    const cursor =
      parsed.data.cursor === undefined ? connection.lastOrderSyncCursor : parsed.data.cursor;
    const page = await fetchOrderPage(connection.provider, {
      externalAccountId: connection.externalAccountId,
      credentials: connection.credentials,
      sellerId: connection.sellerId,
      integrationId: connection.id,
      cursor,
      limit: parsed.data.limit,
    });
    const result = await withAdvisoryLock(
      `seller-order-history-sync:${id}`,
      () => syncOrderPage(connection, page),
    );

    if (result.failed === 0) {
      await markOrderSyncSuccess(sellerId, id, page.nextCursor);
    } else {
      await markOrderSyncFailure(sellerId, id, "partial_order_sync_failure");
    }

    return NextResponse.json(
      { success: result.failed === 0, result, nextCursor: page.nextCursor },
      { status: result.failed === 0 ? 200 : 207 },
    );
  } catch (error) {
    const code = error instanceof CatalogProviderError ? error.code : "order_import_failed";
    await markOrderSyncFailure(sellerId, id, code).catch(() => undefined);
    if (error instanceof CatalogProviderError) {
      return NextResponse.json({ success: false, error: error.code }, { status: error.status });
    }
    logger.error(
      { err: error, sellerId, integrationId: id },
      "[seller/integrations/:id/orders] failed",
    );
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
