import { ImageResponse } from "next/og";
import { dbQuery } from "@/lib/db";
import { isUuidParam as isUuid } from "@/lib/validation/params";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OgImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let row: { title: string | null; thumbnail_url: string | null; view_count: number | null; creator_name: string | null } | null = null;
  // Doar clipuri publice vizibile (altfel titlul/coperta unui draft sau a unui clip
  // ascuns de moderare ajungeau în preview-ul de share); id invalid → fără 22P02.
  if (isUuid(id)) {
    try {
      const { rows } = await dbQuery<any>(
        `SELECT v.title, v.thumbnail_url, v.view_count,
                COALESCE(u.display_name, u.username) AS creator_name
           FROM videos v
           LEFT JOIN users u ON u.id = v.creator_id
          WHERE v.id = $1
            AND v.status = 'ready' AND v.visibility = 'public'
            AND COALESCE(v.is_hidden, false) = false AND v.effective_label = 'safe'
          LIMIT 1`,
        [id],
      );
      row = rows[0] ?? null;
    } catch { /* */ }
  }

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

  const views = Number(row.view_count || 0).toLocaleString("en");

  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", position: "relative", color: "white", fontFamily: "system-ui" }}>
        {row.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={row.thumbnail_url} alt="" width={1200} height={630} style={{ position: "absolute", inset: 0, objectFit: "cover", filter: "brightness(0.55)" }} />
        ) : (
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg,#0f172a,#581c87)" }} />
        )}
        <div style={{ display: "flex", flexDirection: "column", padding: 56, position: "relative", justifyContent: "space-between", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ display: "flex", padding: "8px 18px", background: "#7c3aed", borderRadius: 999, fontSize: 24, fontWeight: 800 }}>▶ VIDEO</div>
            <div style={{ display: "flex", marginLeft: "auto", fontSize: 24, opacity: 0.8 }}>swypik.com</div>
          </div>
          <div style={{ display: "flex", fontSize: 64, fontWeight: 800, lineHeight: 1.1, maxWidth: 1080 }}>
            {(row.title || "Video").slice(0, 120)}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 30, opacity: 0.95 }}>
            <div style={{ display: "flex" }}>by {row.creator_name || "Creator"}</div>
            <div style={{ display: "flex", fontWeight: 700 }}>{views} views</div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
