import { ImageResponse } from "next/og";
import { dbQuery } from "@/lib/db";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OgImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let row: { title: string; image_url: string | null; price_cents: number | null; currency: string | null; brand: string | null } | null = null;
  try {
    const { rows } = await dbQuery<any>(
      `SELECT title, image_url, price_cents, currency, brand
         FROM marketplace_products WHERE id=$1 LIMIT 1`,
      [id],
    );
    row = rows[0] ?? null;
  } catch { /* fallback */ }

  if (!row) {
    return new ImageResponse(
      (
        <div style={{ display: "flex", width: "100%", height: "100%", background: "linear-gradient(135deg,#7c3aed,#db2777)", alignItems: "center", justifyContent: "center", fontSize: 96, color: "white", fontWeight: 800 }}>
          Swypik
        </div>
      ),
      size,
    );
  }

  const price = row.price_cents != null
    ? `${(row.price_cents / 100).toFixed(2)} ${row.currency || "RON"}`
    : "";

  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: "#0f0f17", color: "white", fontFamily: "system-ui" }}>
        {row.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={row.image_url} alt="" width={630} height={630} style={{ objectFit: "cover" }} />
        ) : (
          <div style={{ width: 630, height: 630, background: "#1e1b4b", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 96 }} />
        )}
        <div style={{ display: "flex", flexDirection: "column", padding: 48, flex: 1, justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 28, fontWeight: 800, color: "#a78bfa" }}>
            SWYPIK
          </div>
          <div style={{ display: "flex", fontSize: 44, fontWeight: 700, lineHeight: 1.15, maxWidth: 520 }}>
            {(row.title || "Product").slice(0, 110)}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {row.brand ? <div style={{ display: "flex", fontSize: 24, opacity: 0.7 }}>by {row.brand}</div> : null}
            {price ? (
              <div style={{ display: "flex", fontSize: 56, fontWeight: 800, color: "#10b981" }}>{price}</div>
            ) : null}
            <div style={{ display: "flex", marginTop: 8, fontSize: 22, opacity: 0.6 }}>swypik.com/product/{id.slice(0, 8)}</div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
