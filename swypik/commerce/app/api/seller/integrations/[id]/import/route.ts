import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { withAdvisoryLock } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import {
  getCatalogConnection,
  markCatalogSyncFailure,
  markCatalogSyncSuccess,
} from "@/lib/seller/imports/connections";
import { CatalogProviderError } from "@/lib/seller/imports/common";
import { fetchCatalogPage } from "@/lib/seller/imports/provider";
import { syncCatalogPage } from "@/lib/seller/imports/sync";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const ImportSchema = z.object({
  cursor: z.string().trim().max(2048).nullable().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  dryRun: z.boolean().default(false),
}).strict();

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuidParam(id)) return invalidIdResponse();

  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const rl = await rateLimit("sellerCatalogImport", sellerId);
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  const parsed = ImportSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "validation_error" }, { status: 400 });
  }

  const connection = await getCatalogConnection(sellerId, id);
  if (!connection) {
    return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
  }
  if (connection.status === "disabled") {
    return NextResponse.json(
      { success: false, error: "integration_disabled" },
      { status: 409 },
    );
  }

  try {
    const cursor =
      parsed.data.cursor === undefined ? connection.lastSyncCursor : parsed.data.cursor;
    const page = await fetchCatalogPage(connection.provider, {
      externalAccountId: connection.externalAccountId,
      credentials: connection.credentials,
      sellerId: connection.sellerId,
      integrationId: connection.id,
      cursor,
      limit: parsed.data.limit,
    });
    const result = parsed.data.dryRun
      ? await syncCatalogPage(connection, page, true)
      : await withAdvisoryLock(
          `seller-catalog-sync:${id}`,
          () => syncCatalogPage(connection, page, false),
        );

    if (!parsed.data.dryRun) {
      if (result.failed === 0) {
        await markCatalogSyncSuccess(sellerId, id, page.nextCursor);
      } else {
        // Keep the old cursor when a batch is partial. Retrying is idempotent.
        await markCatalogSyncFailure(sellerId, id, "partial_sync_failure");
      }
    }

    return NextResponse.json(
      {
        success: result.failed === 0,
        result,
        storeCurrency: page.storeCurrency,
        nextCursor: page.nextCursor,
      },
      { status: result.failed === 0 ? 200 : 207 },
    );
  } catch (error) {
    const code =
      error instanceof CatalogProviderError ? error.code : "catalog_import_failed";
    if (!parsed.data.dryRun) {
      await markCatalogSyncFailure(sellerId, id, code).catch(() => undefined);
    }

    if (error instanceof CatalogProviderError) {
      return NextResponse.json(
        { success: false, error: error.code },
        { status: error.status },
      );
    }
    logger.error(
      { err: error, sellerId, integrationId: id },
      "[seller/integrations/:id/import] failed",
    );
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
