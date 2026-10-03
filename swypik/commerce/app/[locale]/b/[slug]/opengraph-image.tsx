/**
 * Dynamic OG image for /b/[slug] — share-optimized for TikTok / IG / WhatsApp.
 * Uses Next.js built-in `ImageResponse` (no extra dep).
 */
import { ImageResponse } from "next/og";
import { dbQuery } from "@/lib/db";

export const runtime = "nodejs"; // pg client requires node runtime
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const FORMAT_LABEL: Record<string, string> = {
  find_me: "AJUTĂ-MĂ SĂ ALEG",
  merita: "MERITĂ?",
  dupe_hunt: "DUPE HUNT",
  roast_cart: "ROAST MY CART",
  drop: "DROP",
  setup: "SETUP",
  review_real: "REVIEW REAL",
};

type Row = {
  title: string;
  format: string;
  vote_count: number;
  author_handle: string | null;
  author_display: string | null;
  opt_a_image: string | null;
  opt_a_label: string | null;
  opt_b_image: string | null;
  opt_b_label: string | null;
};

export default async function OgImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { rows } = await dbQuery<Row>(
    `WITH first_two AS (
       SELECT i.post_id,
              MAX(CASE WHEN i.position = 0 THEN COALESCE(mp.image_url, i.external_image) END) AS opt_a_image,
              MAX(CASE WHEN i.position = 0 THEN COALESCE(i.label, mp.title, i.external_title) END) AS opt_a_label,
              MAX(CASE WHEN i.position = 1 THEN COALESCE(mp.image_url, i.external_image) END) AS opt_b_image,
              MAX(CASE WHEN i.position = 1 THEN COALESCE(i.label, mp.title, i.external_title) END) AS opt_b_label
         FROM community_post_items i
         LEFT JOIN marketplace_products mp ON mp.id = i.product_id
        GROUP BY i.post_id
     )
     SELECT p.title, p.format, p.vote_count,
            u.username AS author_handle, u.display_name AS author_display,
            ft.opt_a_image, ft.opt_a_label, ft.opt_b_image, ft.opt_b_label
       FROM community_posts p
       LEFT JOIN users u ON u.id = p.author_user_id
       LEFT JOIN first_two ft ON ft.post_id = p.id
      WHERE p.slug = $1 AND p.status='active' AND p.is_adult=FALSE
      LIMIT 1`,
    [slug],
  );
  const post = rows[0];

  const fallback = (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        background: "linear-gradient(135deg,#7c3aed 0%,#db2777 100%)",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 96,
        color: "white",
        fontWeight: 800,
      }}
    >
      Swypik
    </div>
  );
  if (!post) return new ImageResponse(fallback, size);

  const badge = FORMAT_LABEL[post.format] ?? post.format.toUpperCase();
  const author = post.author_display || post.author_handle || "Swypik";

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          background: "linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#581c87 100%)",
          padding: 56,
          color: "white",
          fontFamily: "system-ui",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              padding: "8px 20px",
              borderRadius: 999,
              background: "#7c3aed",
              fontSize: 28,
              fontWeight: 800,
              letterSpacing: 1,
            }}
          >
            {badge}
          </div>
          <div style={{ marginLeft: "auto", fontSize: 24, opacity: 0.7 }}>
            swypik.com/b/{slug}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            marginTop: 40,
            fontSize: 56,
            fontWeight: 800,
            lineHeight: 1.15,
            maxWidth: 1080,
          }}
        >
          {post.title.length > 120 ? post.title.slice(0, 117) + "…" : post.title}
        </div>

        <div style={{ display: "flex", gap: 24, marginTop: 36, flex: 1 }}>
          {[
            { img: post.opt_a_image, label: post.opt_a_label, tag: "A" },
            { img: post.opt_b_image, label: post.opt_b_label, tag: "B" },
          ].map((opt) => (
            <div
              key={opt.tag}
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                background: "rgba(255,255,255,0.07)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 28,
                padding: 24,
                alignItems: "center",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 56,
                  height: 56,
                  borderRadius: 999,
                  background: "#7c3aed",
                  fontSize: 32,
                  fontWeight: 800,
                  marginBottom: 16,
                }}
              >
                {opt.tag}
              </div>
              {opt.img ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={opt.img}
                  alt=""
                  width={220}
                  height={220}
                  style={{ borderRadius: 20, objectFit: "cover" }}
                />
              ) : (
                <div
                  style={{
                    width: 220,
                    height: 220,
                    borderRadius: 20,
                    background: "rgba(255,255,255,0.1)",
                  }}
                />
              )}
              {opt.label ? (
                <div
                  style={{
                    marginTop: 16,
                    fontSize: 24,
                    fontWeight: 600,
                    textAlign: "center",
                    opacity: 0.9,
                    maxWidth: 360,
                  }}
                >
                  {opt.label.length > 60 ? opt.label.slice(0, 57) + "…" : opt.label}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            marginTop: 32,
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 26,
            opacity: 0.85,
          }}
        >
          <div style={{ display: "flex" }}>de {author}</div>
          <div style={{ display: "flex", fontWeight: 700 }}>
            {post.vote_count} vot{post.vote_count === 1 ? "" : "uri"}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
