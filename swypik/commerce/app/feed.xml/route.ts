import { dbQuery } from "@/lib/db";
import { APP_URL } from "@/lib/app-url";

export const dynamic = "force-dynamic";
export const revalidate = 600;
export const runtime = "nodejs";

const BASE = APP_URL;

function escape(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET() {
  let items: Array<{ id: string; title: string; image: string | null; updated_at: Date | null }> = [];
  try {
    const { rows } = await dbQuery<any>(
      `SELECT id::text,
              COALESCE(title, '') AS title,
              image_url AS image,
              updated_at
         FROM marketplace_products
        WHERE status = 'active'
          AND COALESCE(effective_label, 'safe') = 'safe'
          AND COALESCE(is_adult, false) = false
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 50`,
    );
    items = rows;
  } catch { /* fallback empty */ }

  const lastBuild = new Date().toUTCString();

  const itemsXml = items.map((it) => {
    const link = `${BASE}/product/${it.id}`;
    const pub = it.updated_at ? new Date(it.updated_at).toUTCString() : lastBuild;
    const title = escape(it.title || `Product ${it.id.slice(0, 8)}`);
    const enclosure = it.image
      ? `<enclosure url="${escape(it.image)}" type="image/jpeg" />`
      : "";
    return `    <item>
      <title>${title}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${pub}</pubDate>
      ${enclosure}
    </item>`;
  }).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Swypik — Produse noi</title>
    <link>${BASE}</link>
    <atom:link href="${BASE}/feed.xml" rel="self" type="application/rss+xml" />
    <description>Cele mai noi produse video-first din marketplace-ul Swypik.</description>
    <language>ro</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <ttl>60</ttl>
${itemsXml}
  </channel>
</rss>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=600, stale-while-revalidate=600",
    },
  });
}
