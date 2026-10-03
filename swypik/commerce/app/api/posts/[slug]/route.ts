/**
 * GET /api/posts/[slug] — public read of a single Arena post.
 * No auth required. Cache: 30s public.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const dynamic = "force-dynamic";

type PostRow = {
  id: string;
  slug: string;
  format: string;
  title: string;
  body: string | null;
  vote_count: number;
  comment_count: number;
  save_count: number;
  view_count: number;
  share_count: number;
  hot_score: string;
  ends_at: string | null;
  created_at: string;
  author_id: string;
  author_handle: string | null;
  author_display: string | null;
  author_avatar: string | null;
};

type ItemRow = {
  option_key: string;
  label: string | null;
  vote_count: number;
  position: number;
  product_id: string | null;
  product_title: string | null;
  product_image: string | null;
  product_price_minor: number | null;
  product_currency: string | null;
  external_url: string | null;
  external_image: string | null;
  external_title: string | null;
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  if (!slug || slug.length > 80) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }

  try {
    const { rows } = await dbQuery<PostRow>(
      `SELECT
         p.id, p.slug, p.format, p.title, p.body,
         p.vote_count, p.comment_count, p.save_count, p.view_count, p.share_count,
         p.hot_score::text AS hot_score,
         p.ends_at, p.created_at,
         p.author_user_id AS author_id,
         u.username AS author_handle,
         u.display_name AS author_display,
         u.avatar_url AS author_avatar
       FROM community_posts p
       LEFT JOIN users u ON u.id = p.author_user_id
       WHERE p.slug = $1
         AND p.status = 'active'
         AND p.is_adult = FALSE
       LIMIT 1`,
      [slug],
    );

    const post = rows[0];
    if (!post) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const { rows: items } = await dbQuery<ItemRow>(
      `SELECT
         i.option_key, i.label, i.vote_count, i.position,
         i.product_id,
         mp.title AS product_title,
         mp.image_url AS product_image,
         mp.price_cents AS product_price_minor,
         mp.currency AS product_currency,
         i.external_url, i.external_image, i.external_title
       FROM community_post_items i
       LEFT JOIN marketplace_products mp ON mp.id = i.product_id
       WHERE i.post_id = $1
       ORDER BY i.position`,
      [post.id],
    );

    return applyCachePolicy(
      NextResponse.json(
      {
        id: post.id,
        slug: post.slug,
        format: post.format,
        title: post.title,
        body: post.body,
        counts: {
          votes: post.vote_count,
          comments: post.comment_count,
          saves: post.save_count,
          views: post.view_count,
          shares: post.share_count,
        },
        hotScore: Number(post.hot_score),
        endsAt: post.ends_at,
        createdAt: post.created_at,
        author: {
          id: post.author_id,
          handle: post.author_handle,
          displayName: post.author_display,
          avatar: post.author_avatar,
        },
        options: items.map((i) => ({
          optionKey: i.option_key,
          label: i.label,
          votes: i.vote_count,
          product: i.product_id
            ? {
                id: i.product_id,
                title: i.product_title,
                image: i.product_image,
                priceMinor: i.product_price_minor,
                currency: i.product_currency,
              }
            : null,
          external: i.external_url
            ? {
                url: i.external_url,
                image: i.external_image,
                title: i.external_title,
              }
            : null,
        })),
      }),
      "posts/[slug]",
      req,
    );
  } catch (err) {
    return NextResponse.json(
      { error: "internal", message: (err as Error).message },
      { status: 500 },
    );
  }
}
