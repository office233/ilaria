/**
 * Swypik Arena — community posts.
 * (format "battle" retras 2026-08: nefolosit, UI-ul /battles a fost sters)
 *
 *   GET  /api/posts   → public feed (read-only listing, hot/new/ending)
 *   POST /api/posts   → create a new post (authenticated)
 *
 * Query params for GET:
 *   format=merita|find_me|setup|drop|review_real|dupe_hunt|roast_cart
 *   sort=hot|new|ending     (default: hot)
 *   limit=1..50             (default: 20)
 *   cursor=<iso ts>         (optional)
 *
 * POST body (JSON):
 *   { format, title, body?, endsAt?, options?: Array<{
 *       optionKey?, label?, productId?, externalUrl?, externalImage?, externalTitle?
 *   }> }
 *   - find_me / dupe_hunt require ≥2 options.
 *   - Each option needs productId OR externalUrl.
 *
 * Title + body are run through `moderateUserText("post")` (heuristic + Azure
 * Content Safety) — blocked/adult/AI review ⇒ 422.
 */

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { dbQuery, getDb } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { moderateUserText } from "@/lib/moderation/ai-text";
import { recordStrike, suspensionGuard } from "@/lib/moderation/strikes";
import { rateLimit } from "@/lib/security/rate-limit";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const dynamic = "force-dynamic";

const FORMATS = new Set([
  "merita",
  "find_me",
  "setup",
  "drop",
  "review_real",
  "dupe_hunt",
  "roast_cart",
]);

const MIN_OPTIONS_BY_FORMAT: Record<string, number> = {
  find_me: 2,
  dupe_hunt: 2,
};

// ===================================================================
// GET — public feed
// ===================================================================

type PostRow = {
  id: string;
  slug: string | null;
  format: string;
  title: string;
  body: string | null;
  budget_minor: number | null;
  budget_currency: string | null;
  vote_count: number;
  comment_count: number;
  save_count: number;
  view_count: number;
  hot_score: string;
  ends_at: string | null;
  created_at: string;
  author_id: string;
  author_handle: string | null;
  author_display: string | null;
  author_avatar: string | null;
};

type ItemRow = {
  post_id: string;
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
  external_price_minor: number | null;
  external_currency: string | null;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = url.searchParams.get("format");
  const sort = url.searchParams.get("sort") || "hot";
  const limitRaw = Number(url.searchParams.get("limit") || 20);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(Math.trunc(limitRaw), 50))
    : 20;
  const cursor = url.searchParams.get("cursor");

  if (format && !FORMATS.has(format)) {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }

  const orderBy =
    sort === "new"
      ? "p.created_at DESC"
      : sort === "ending"
        ? "(p.ends_at IS NULL), p.ends_at ASC"
        : "p.hot_score DESC, p.created_at DESC";

  const where: string[] = ["p.status = 'active'", "p.is_adult = FALSE"];
  const params: unknown[] = [];
  if (format) {
    params.push(format);
    where.push(`p.format = $${params.length}`);
  }
  if (cursor) {
    params.push(cursor);
    where.push(`p.created_at < $${params.length}`);
  }
  params.push(limit);

  try {
    const { rows: posts } = await dbQuery<PostRow>(
      `SELECT
         p.id, p.slug, p.format, p.title, p.body,
         p.budget_minor, p.budget_currency,
         p.vote_count, p.comment_count, p.save_count, p.view_count,
         p.hot_score::text AS hot_score,
         p.ends_at, p.created_at,
         p.author_user_id AS author_id,
         u.username AS author_handle,
         u.display_name AS author_display,
         u.avatar_url AS author_avatar
       FROM community_posts p
       LEFT JOIN users u ON u.id = p.author_user_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${orderBy}
       LIMIT $${params.length}`,
      params,
    );

    if (posts.length === 0) {
      return applyCachePolicy(NextResponse.json({ posts: [], nextCursor: null }), "posts", req);
    }

    const ids = posts.map((p) => p.id);
    const { rows: items } = await dbQuery<ItemRow>(
      `SELECT
         i.post_id, i.option_key, i.label, i.vote_count, i.position,
         i.product_id,
         mp.title AS product_title,
         mp.image_url AS product_image,
         mp.price_cents AS product_price_minor,
         mp.currency AS product_currency,
         i.external_url, i.external_image, i.external_title,
         i.external_price_minor, i.external_currency
       FROM community_post_items i
       LEFT JOIN marketplace_products mp ON mp.id = i.product_id
       WHERE i.post_id = ANY($1::uuid[])
       ORDER BY i.post_id, i.position`,
      [ids],
    );

    const itemsByPost = new Map<string, ItemRow[]>();
    for (const it of items) {
      const arr = itemsByPost.get(it.post_id) ?? [];
      arr.push(it);
      itemsByPost.set(it.post_id, arr);
    }

    const out = posts.map((p) => ({
      id: p.id,
      slug: p.slug,
      format: p.format,
      title: p.title,
      body: p.body,
      budget: p.budget_minor
        ? { amountMinor: p.budget_minor, currency: p.budget_currency || "RON" }
        : null,
      counts: {
        votes: p.vote_count,
        comments: p.comment_count,
        saves: p.save_count,
        views: p.view_count,
      },
      hotScore: Number(p.hot_score),
      endsAt: p.ends_at,
      createdAt: p.created_at,
      author: {
        id: p.author_id,
        handle: p.author_handle,
        displayName: p.author_display,
        avatar: p.author_avatar,
      },
      items: (itemsByPost.get(p.id) ?? []).map((i) => ({
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
            priceMinor: i.external_price_minor,
            currency: i.external_currency,
          }
          : null,
      })),
    }));

    const last = posts[posts.length - 1];
    return applyCachePolicy(
      NextResponse.json({ posts: out, nextCursor: posts.length === limit ? last.created_at : null }),
      "posts",
      req,
    );
  } catch (err) {
    // Tables may not exist yet on first deploy — fail soft so the UI can render.
    return NextResponse.json(
      { posts: [], nextCursor: null, error: (err as Error).message },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}

// ===================================================================
// POST — create new community post
// ===================================================================

type IncomingOption = {
  optionKey?: unknown;
  label?: unknown;
  productId?: unknown;
  externalUrl?: unknown;
  externalImage?: unknown;
  externalTitle?: unknown;
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function randomSuffix(len = 6): string {
  return randomBytes(Math.ceil(len / 2) + 1).toString("hex").slice(0, len);
}

export async function POST(req: Request) {
  const auth = await getAuthUser();
  if (!auth.userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const block = await suspensionGuard(auth.userId);
  if (block) return NextResponse.json(block.body, { status: block.status });

  const rl = await rateLimit("postsCreate", auth.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const format = String(body.format || "").trim();
  if (!FORMATS.has(format)) {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }

  const title = String(body.title || "").trim();
  if (title.length < 3 || title.length > 140) {
    return NextResponse.json({ error: "title_length" }, { status: 400 });
  }

  const text = String(body.body || "").trim().slice(0, 2000) || null;
  const endsAtRaw = body.endsAt;
  const endsAt =
    endsAtRaw && typeof endsAtRaw === "string" && !Number.isNaN(Date.parse(endsAtRaw))
      ? new Date(endsAtRaw)
      : null;

  // Moderation gate on combined text — context="post" ⇒ blocked/adult reject (422).
  const modCheck = await moderateUserText(`${title}\n${text ?? ""}`, "post");
  if (modCheck.action === "reject") {
    void recordStrike({
      userId: auth.userId,
      label: modCheck.label === "blocked" ? "blocked" : "adult",
      context: "post",
      reason: modCheck.message,
      reasons: modCheck.reasons,
      signals: modCheck.signals as Record<string, unknown>,
    });
    return NextResponse.json(
      {
        error: modCheck.message ?? "Conținut respins de moderare.",
        reasons: modCheck.reasons,
      },
      { status: 422 },
    );
  }

  // Options validation
  const rawOptions = Array.isArray(body.options) ? (body.options as IncomingOption[]) : [];
  const minOptions = MIN_OPTIONS_BY_FORMAT[format] ?? 0;
  if (rawOptions.length < minOptions) {
    return NextResponse.json(
      { error: "need_min_options", min: minOptions },
      { status: 400 },
    );
  }
  if (rawOptions.length > 8) {
    return NextResponse.json({ error: "too_many_options" }, { status: 400 });
  }

  const normalizedOptions = rawOptions.map((opt, idx) => {
    const optionKey = String(opt.optionKey || String.fromCharCode(97 + idx)).slice(0, 12);
    const label = opt.label != null ? String(opt.label).trim().slice(0, 80) : null;
    const productId =
      typeof opt.productId === "string" && opt.productId.trim().length === 36
        ? opt.productId
        : null;
    const externalUrl =
      typeof opt.externalUrl === "string" && /^https?:\/\//i.test(opt.externalUrl)
        ? opt.externalUrl.slice(0, 500)
        : null;
    const externalImage =
      typeof opt.externalImage === "string" && /^https?:\/\//i.test(opt.externalImage)
        ? opt.externalImage.slice(0, 500)
        : null;
    const externalTitle =
      typeof opt.externalTitle === "string" ? opt.externalTitle.trim().slice(0, 140) : null;
    if (!productId && !externalUrl) return null;
    return { optionKey, label, productId, externalUrl, externalImage, externalTitle, position: idx };
  });
  if (normalizedOptions.some((o) => o === null)) {
    return NextResponse.json({ error: "option_needs_product_or_url" }, { status: 400 });
  }

  const baseSlug = slugify(title) || "post";
  let slug = `${baseSlug}-${randomSuffix()}`;

  const pool = getDb();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let inserted: { id: string; slug: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await client.query<{ id: string; slug: string }>(
          `INSERT INTO community_posts
             (slug, author_user_id, format, title, body, ends_at, status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::jsonb)
           RETURNING id, slug`,
          [
            slug,
            auth.userId,
            format,
            title,
            text,
            endsAt,
            JSON.stringify({
              moderation: { label: modCheck.label, reasons: modCheck.reasons },
              created_via: "api_v1",
            }),
          ],
        );
        inserted = res.rows[0];
        break;
      } catch (err) {
        const msg = (err as Error).message || "";
        if (msg.includes("community_posts_slug_key")) {
          slug = `${baseSlug}-${randomSuffix()}`;
          continue;
        }
        throw err;
      }
    }

    if (!inserted) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "slug_collision" }, { status: 500 });
    }

    for (const opt of normalizedOptions) {
      if (!opt) continue;
      await client.query(
        `INSERT INTO community_post_items
           (post_id, product_id, external_url, external_image, external_title,
            option_key, label, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          inserted.id,
          opt.productId,
          opt.externalUrl,
          opt.externalImage,
          opt.externalTitle,
          opt.optionKey,
          opt.label,
          opt.position,
        ],
      );
    }

    await client.query("COMMIT");

    return NextResponse.json(
      {
        id: inserted.id,
        slug: inserted.slug,
        url: `/b/${inserted.slug}`,
        moderation: { label: modCheck.label, action: modCheck.action },
      },
      { status: 201 },
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { });
    return NextResponse.json(
      { error: "internal", message: (err as Error).message },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}
