/**
 * Product sitemap chunks — explicit route handler.
 * URL pattern: /products/sitemap/0.xml ... /products/sitemap/N.xml
 *
 * Why a route handler instead of Next.js MetadataRoute.Sitemap + generateSitemaps:
 *   With dynamic="force-dynamic" + revalidate, Next does NOT prerender via
 *   generateSitemaps, so individual /products/sitemap/N.xml URLs return 404.
 *   An explicit route handler bypasses the metadata convention entirely.
 *
 * Each chunk: 10k products with per-locale hreflang alternates.
 */

import { dbQuery } from "@/lib/db";
import { LOCALES, DEFAULT_LOCALE } from "@/lib/i18n/config";
import { NextResponse } from "next/server";
import { APP_URL } from "@/lib/app-url";

export const dynamic = "force-dynamic";
export const revalidate = 3600;

const CHUNK_SIZE = 10000;
const BASE_URL = APP_URL;

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function localizedUrl(locale: string, slugOrId: string): string {
  // Default locale (ro) doesn't carry prefix on swypik (per i18n config)
  if (locale === DEFAULT_LOCALE) {
    return `${BASE_URL}/product/${slugOrId}`;
  }
  return `${BASE_URL}/${locale}/product/${slugOrId}`;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  // id arrives as "0.xml", "1.xml" etc. Strip .xml.
  const cleanId = id.replace(/\.xml$/i, "");
  const chunkId = Number(cleanId);
  if (!Number.isFinite(chunkId) || chunkId < 0) {
    return new NextResponse("Not found", { status: 404 });
  }

  const offset = chunkId * CHUNK_SIZE;

  let rows: Array<{ id: string; updated_at: Date | null; image_url: string | null }> = [];
  try {
    const res = await dbQuery<{ id: string; updated_at: Date | null; image_url: string | null }>(
      `SELECT p.id, p.updated_at, p.image_url
         FROM marketplace_products p
        WHERE p.status='active' AND p.effective_label='safe'
        ORDER BY p.id
        LIMIT $1 OFFSET $2`,
      [CHUNK_SIZE, offset],
    );
    rows = res.rows;
  } catch (e) {
    console.error("[ProductsSitemap] fetch chunk failed:", e);
    return new NextResponse("DB error", { status: 503 });
  }

  if (rows.length === 0) {
    // Empty but valid sitemap
    const empty = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    return new NextResponse(empty, {
      status: 200,
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
  }

  // Batch-load translations (slugs per locale) for all product ids
  const ids = rows.map((r) => r.id);
  const trIdx = new Map<string, Map<string, string | null>>();
  try {
    const { rows: trRows } = await dbQuery<{ product_id: string; locale: string; slug: string | null }>(
      `SELECT product_id, locale, NULLIF(slug, '') AS slug
         FROM product_translations
        WHERE locale = ANY($1::text[]) AND product_id = ANY($2::uuid[])`,
      [[...LOCALES], ids],
    );
    for (const t of trRows) {
      let m = trIdx.get(t.product_id);
      if (!m) {
        m = new Map();
        trIdx.set(t.product_id, m);
      }
      m.set(t.locale, t.slug);
    }
  } catch (e) {
    console.error("[ProductsSitemap] translations fetch failed:", e);
  }

  const urlEntries: string[] = [];
  for (const row of rows) {
    const langs = trIdx.get(row.id);
    // Pick canonical (RO slug preferred, else id)
    const roSlug = langs?.get(DEFAULT_LOCALE) || null;
    const canonical = roSlug ? `${BASE_URL}/product/${roSlug}` : `${BASE_URL}/product/${row.id}`;
    const lastmod = (row.updated_at ? new Date(row.updated_at) : new Date()).toISOString();

    // Build hreflang alternates for every locale that has either a translation row or fallback to id
    const altLinks: string[] = [];
    for (const locale of LOCALES) {
      const slug = langs?.get(locale) || null;
      const href = localizedUrl(locale, slug || row.id);
      altLinks.push(
        `      <xhtml:link rel="alternate" hreflang="${locale}" href="${xmlEscape(href)}"/>`,
      );
    }
    // x-default points to canonical (no locale prefix)
    altLinks.push(
      `      <xhtml:link rel="alternate" hreflang="x-default" href="${xmlEscape(canonical)}"/>`,
    );

    // image:image (one per product, optional)
    const imageBlock = row.image_url
      ? `      <image:image><image:loc>${xmlEscape(row.image_url)}</image:loc></image:image>\n`
      : "";

    urlEntries.push(
      `  <url>\n` +
        `      <loc>${xmlEscape(canonical)}</loc>\n` +
        `      <lastmod>${lastmod}</lastmod>\n` +
        `      <changefreq>weekly</changefreq>\n` +
        `      <priority>0.7</priority>\n` +
        altLinks.join("\n") +
        "\n" +
        imageBlock +
        `  </url>`,
    );
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:xhtml="http://www.w3.org/1999/xhtml"\n` +
    `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
    urlEntries.join("\n") +
    `\n</urlset>\n`;

  return new NextResponse(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
