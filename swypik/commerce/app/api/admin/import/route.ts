import { NextResponse } from "next/server";
import { labelProduct } from "@/lib/moderation/labelProduct";
import { autoEmbedProduct } from "@/lib/ai/auto-embed";
import { dbQuery } from "@/lib/db";

import { requireAdmin } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/security/admin-audit";

import { logger } from "@/lib/logger";
import { DEFAULT_CURRENCY } from "@/lib/i18n/config";
export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface CsvRow {
  [key: string]: string | undefined;
  title?: string;
  price?: string;
  description?: string;
  image_url?: string;
  category?: string;
  stock?: string;
}

// `reason` is a stable machine code the client translates; `params` carries
// interpolation values (e.g. the offending raw price string, truncated DB error).
interface ImportError {
  row: number;
  reason: string;
  params?: Record<string, string>;
  data?: Record<string, string | undefined>;
}

/**
 * Minimal RFC-4180-ish CSV parser.
 * Handles quoted fields with embedded commas, newlines & escaped quotes ("").
 */
function parseCsv(raw: string): Record<string, string>[] {
  const lines: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuote = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (inQuote) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === ",") {
        current.push(field);
        field = "";
      } else if (ch === "\n" || (ch === "\r" && raw[i + 1] === "\n")) {
        current.push(field);
        field = "";
        if (current.some((c) => c.trim() !== "")) lines.push(current);
        current = [];
        if (ch === "\r") i++;
      } else {
        field += ch;
      }
    }
  }

  // flush last field / row
  current.push(field);
  if (current.some((c) => c.trim() !== "")) lines.push(current);

  if (lines.length === 0) return [];

  const headers = lines[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < lines.length; r++) {
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (lines[r][c] ?? "").trim();
    }
    rows.push(obj);
  }

  return rows;
}

function inventoryFromStock(stock: string | undefined): string {
  if (!stock) return "unknown";
  const n = parseInt(stock, 10);
  if (isNaN(n)) return "unknown";
  if (n <= 0) return "out_of_stock";
  if (n <= 5) return "low_stock";
  return "in_stock";
}

/* ------------------------------------------------------------------ */
/*  POST  /api/admin/import                                            */
/* ------------------------------------------------------------------ */

export async function POST(req: Request) {
  const actor = await requireAdmin(req, "commerce");
  if (actor instanceof NextResponse) return actor;

  try {
    const body = await req.json();
    const csvText: string | undefined = body.csv;

    if (!csvText || typeof csvText !== "string") {
      return NextResponse.json(
        { success: false, imported: 0, errors: [{ row: 0, reason: "no_csv_data" }] },
        { status: 400 }
      );
    }

    // DoS guard: cap payload size and row count.
    const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MB
    const MAX_CSV_ROWS = 5000;
    if (Buffer.byteLength(csvText, "utf8") > MAX_CSV_BYTES) {
      return NextResponse.json(
        { success: false, imported: 0, errors: [{ row: 0, reason: "csv_too_large" }] },
        { status: 413 }
      );
    }

    const rows = parseCsv(csvText);

    if (rows.length > MAX_CSV_ROWS) {
      return NextResponse.json(
        { success: false, imported: 0, errors: [{ row: 0, reason: "too_many_rows", params: { max: String(MAX_CSV_ROWS) } }] },
        { status: 413 }
      );
    }

    if (rows.length === 0) {
      return NextResponse.json(
        { success: false, imported: 0, errors: [{ row: 0, reason: "empty_csv" }] },
        { status: 400 }
      );
    }

    let imported = 0;
    const errors: ImportError[] = [];

    for (let i = 0; i < rows.length; i++) {
      const rowData = rows[i];
      const row = rowData as CsvRow;
      const rowNumber = i + 2; // +2 because row 1 is the header, and we're 1-indexed

      const title = row.title?.trim();
      const priceRaw = row.price?.trim();

      // ---- validation ----
      if (!title) {
        errors.push({ row: rowNumber, reason: "missing_title", data: rowData });
        continue;
      }

      if (!priceRaw) {
        errors.push({ row: rowNumber, reason: "missing_price", data: rowData });
        continue;
      }

      const priceNum = parseFloat(priceRaw);
      if (isNaN(priceNum) || priceNum < 0) {
        errors.push({ row: rowNumber, reason: "invalid_price", params: { price: priceRaw }, data: rowData });
        continue;
      }

      const priceCents = Math.round(priceNum * 100);
      const slug = slugify(title) + "-" + Date.now().toString(36) + i.toString(36);
      const description = row.description?.trim() || null;
      const imageUrl = row.image_url?.trim() || null;
      const category = row.category?.trim() || null;
      const inventoryStatus = inventoryFromStock(row.stock);

      try {
        const { rows: insRows } = await dbQuery(
          `INSERT INTO marketplace_products (
            title, slug, description, image_url, category,
            currency, price_cents, status, inventory_status,
            source_type, metadata
          ) VALUES (
            $1, $2, $3, $4, $5,
            $8, $6, 'active', $7,
            'manual', jsonb_build_object('imported_via', 'csv_bulk', 'imported_at', now()::text)
          ) RETURNING id`,
          [title, slug, description, imageUrl, category, priceCents, inventoryStatus, DEFAULT_CURRENCY]
        );
        if (insRows[0]?.id) {
          autoEmbedProduct(insRows[0].id, title, description);
          labelProduct({ id: insRows[0].id, title, description, category }).catch(() => { });
        }
        imported++;
      } catch (dbErr) {
        const message = dbErr instanceof Error ? dbErr.message.slice(0, 200) : "unknown";
        errors.push({
          row: rowNumber,
          reason: "db_error",
          params: { message },
          data: rowData,
        });
      }
    }

    await logAdminAction({
      action: "marketplace_product.bulk_import",
      targetType: "marketplace_product",
      details: { imported, total: rows.length, errors: errors.length },
      req,
      actor,
    });

    return NextResponse.json({
      success: true,
      imported,
      total: rows.length,
      errors,
    });
  } catch (err) {
    logger.error({ err }, "CSV import error:");
    const message = err instanceof Error ? err.message : "server_error";
    return NextResponse.json(
      { success: false, imported: 0, errors: [{ row: 0, reason: "server_error", params: { message } }] },
      { status: 500 }
    );
  }
}
