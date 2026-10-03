import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";

import { requireAdmin } from "@/lib/admin/guard";

import { logger } from "@/lib/logger";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const actor = await requireAdmin(req, "commerce");
  if (actor instanceof NextResponse) return actor;

  try {
    const url = new URL(req.url);
    const rawLimit = Number(url.searchParams.get("limit") || 50);
    const rawOffset = Number(url.searchParams.get("offset") || 0);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 50;
    const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;

    const status = (url.searchParams.get("status") || "all").toLowerCase();
    const source = (url.searchParams.get("source") || "all").toLowerCase();
    const search = (url.searchParams.get("search") || "").trim();
    const sortField = (url.searchParams.get("sort") || "date").toLowerCase();
    const sortDir = (url.searchParams.get("dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

    const where: string[] = [];
    const params: (string | number)[] = [];

    if (status !== "all") {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (source !== "all") {
      params.push(source);
      where.push(`source_type = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(
        `(title ILIKE $${params.length} OR slug ILIKE $${params.length} OR brand ILIKE $${params.length} OR category ILIKE $${params.length})`
      );
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const orderSql =
      sortField === "title"
        ? `title ${sortDir} NULLS LAST`
        : sortField === "price"
        ? `price_cents ${sortDir} NULLS LAST`
        : `updated_at ${sortDir} NULLS LAST, created_at ${sortDir}`;

    // Totaluri pe filtre aplicate — KPI cards reflectă filtrul curent
    const countSql = `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'active') AS active,
        COUNT(*) FILTER (WHERE image_url IS NOT NULL AND image_url <> '') AS with_image,
        COUNT(*) FILTER (WHERE (metadata->>'has_video')::boolean = true) AS with_video
      FROM marketplace_products
      ${whereSql}
    `;
    const totalsRes = await dbQuery(countSql, params);
    const totals = totalsRes.rows[0] || { total: 0, active: 0, with_image: 0, with_video: 0 };

    params.push(limit);
    params.push(offset);

    const { rows } = await dbQuery(
      `
      SELECT
        id,
        title,
        slug,
        brand,
        category,
        status,
        source_type,
        inventory_status,
        product_url,
        image_url,
        currency,
        price_cents,
        created_at,
        updated_at,
        (metadata->>'orders_count')::int AS orders,
        (metadata->>'has_video')::boolean AS has_video
      FROM marketplace_products
      ${whereSql}
      ORDER BY ${orderSql}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
      params
    );

    const totalNum = Number(totals.total) || 0;
    return NextResponse.json({
      products: rows,
      limit,
      offset,
      total: totalNum,
      totals: {
        total: totalNum,
        active: Number(totals.active) || 0,
        with_image: Number(totals.with_image) || 0,
        with_video: Number(totals.with_video) || 0,
      },
      hasMore: offset + rows.length < totalNum,
    });
  } catch (error) {
    logger.error({ err: error }, "Admin marketplace fetch error:");
    return NextResponse.json(
      { error: "fetch_failed" },
      { status: 500 }
    );
  }
}
