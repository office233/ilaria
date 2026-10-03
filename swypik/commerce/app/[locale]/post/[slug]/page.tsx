import { Link } from "@/lib/i18n/navigation";
import { notFound } from "next/navigation";
import { dbQuery } from "@/lib/db";
import { MessageSquare, TrendingUp, Clock, Eye, Share2 } from "lucide-react";
import VoteButtons from "./VoteButtons";
import { getTranslations } from "next-intl/server";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

type PostRow = {
  id: string;
  slug: string;
  format: string;
  title: string;
  body: string | null;
  vote_count: number;
  comment_count: number;
  view_count: number;
  share_count: number;
  ends_at: string | null;
  created_at: string;
  author_id: string;
  author_handle: string | null;
  author_display: string | null;
  author_avatar: string | null;
  video_id: string | null;
  video_playback_url: string | null;
  video_thumbnail_url: string | null;
};

type ItemRow = {
  option_key: string;
  label: string | null;
  vote_count: number;
  position: number;
  product_id: string | null;
  product_title: string | null;
  product_image: string | null;
  external_url: string | null;
  external_image: string | null;
  external_title: string | null;
};

const FORMAT_LABEL: Record<string, string> = {
  merita: "Merită?",
  battle: "Battle",
  find_me: "Find me",
  setup: "Setup",
  drop: "Drop",
  review_real: "Review",
  dupe_hunt: "Dupe Hunt",
  roast_cart: "Roast Cart",
};

function fmtRemaining(endsAt: string | null, t: (key: string, values?: Record<string, string | number | Date>) => string): string {
  if (!endsAt) return "";
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return t("ended");
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  if (d > 0) return t("remainingDaysHours", { d, h });
  return t("remainingHours", { h });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}) {
  const { slug, locale } = await params;
  const { rows } = await dbQuery<{ title: string; format: string; slug: string | null }>(
    `SELECT title, format, slug FROM community_posts WHERE slug=$1 OR id::text=$1 LIMIT 1`,
    [slug],
  );
  if (!rows[0]) return { title: "Post — Swypik" };
  return {
    title: `${rows[0].title} — Swypik ${FORMAT_LABEL[rows[0].format] || ""}`,
    alternates: localizedAlternates(locale, `/post/${encodeURIComponent(rows[0].slug || slug)}`),
  };
}

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!slug || slug.length > 80) notFound();
  const t = await getTranslations("postPage");

  const { rows } = await dbQuery<PostRow>(
    `SELECT
       p.id, p.slug, p.format, p.title, p.body,
       p.vote_count, p.comment_count, p.view_count, p.share_count,
       p.ends_at, p.created_at,
       p.author_user_id AS author_id,
       u.username    AS author_handle,
       u.display_name AS author_display,
       u.avatar_url   AS author_avatar,
       p.video_id,
       v.playback_url  AS video_playback_url,
       v.thumbnail_url AS video_thumbnail_url
     FROM community_posts p
     LEFT JOIN users u ON u.id = p.author_user_id
     LEFT JOIN videos v ON v.id = p.video_id
     WHERE (p.slug = $1 OR p.id::text = $1) AND p.status = 'active' AND p.is_adult = FALSE
     LIMIT 1`,
    [slug],
  );

  const post = rows[0];
  if (!post) notFound();

  // Fire-and-forget view increment
  dbQuery(`UPDATE community_posts SET view_count = view_count + 1 WHERE id=$1`, [
    post.id,
  ]).catch(() => { });

  const { rows: items } = await dbQuery<ItemRow>(
    `SELECT
       i.option_key, i.label, i.vote_count, i.position,
       i.product_id,
       p.title       AS product_title,
       p.image_url   AS product_image,
       i.external_url, i.external_image, i.external_title
     FROM community_post_items i
     LEFT JOIN marketplace_products p ON p.id = i.product_id
     WHERE i.post_id = $1
     ORDER BY i.position ASC, i.option_key ASC`,
    [post.id],
  );

  const voteItems = items.map((it) => ({
    optionKey: it.option_key,
    label: it.product_title || it.external_title || it.label || it.option_key,
    voteCount: it.vote_count,
    imageUrl: it.product_image || it.external_image,
  }));

  const canonicalSlug = post.slug || post.id;

  return (
    <main className="min-h-screen bg-[#0D0D0D] text-white pb-24">
      <header className="sticky top-0 z-10 bg-[#0D0D0D]/90 backdrop-blur border-b border-white/10 px-4 py-3">
        <Link href="/" className="text-sm text-white/60 hover:text-white">← {t("home")}</Link>
      </header>

      <article className="mx-auto max-w-2xl px-4 py-6">
        <div className="text-xs font-bold text-[#7C3AED] uppercase tracking-wide">
          {FORMAT_LABEL[post.format] || post.format}
        </div>
        <h1 className="text-2xl font-black mt-1">{post.title}</h1>

        <div className="mt-3 flex items-center gap-3 text-xs text-white/60">
          {post.author_handle ? (
            <Link
              href={`/u/${post.author_handle}`}
              className="flex items-center gap-2 hover:text-white transition"
            >
              {post.author_avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={post.author_avatar} alt="" className="w-6 h-6 rounded-full" />
              ) : (
                <span className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-[10px]">
                  {(post.author_handle || "?").slice(0, 1).toUpperCase()}
                </span>
              )}
              <span>@{post.author_handle}</span>
            </Link>
          ) : (
            <span className="text-white/40">{t("anonymous")}</span>
          )}
          {post.ends_at ? (
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3 h-3" /> {fmtRemaining(post.ends_at, t)}
            </span>
          ) : null}
        </div>

        {post.body ? (
          <p className="mt-4 text-sm text-white/80 whitespace-pre-wrap">{post.body}</p>
        ) : null}

        {post.video_playback_url ? (
          <div className="mt-4 rounded-2xl overflow-hidden bg-black aspect-[9/16] max-h-[70vh]">
            <video
              src={post.video_playback_url}
              poster={post.video_thumbnail_url || undefined}
              controls
              playsInline
              className="w-full h-full object-contain"
            />
          </div>
        ) : null}

        {voteItems.length > 0 ? (
          <section className="mt-6">
            <VoteButtons slug={canonicalSlug} items={voteItems} />
          </section>
        ) : null}

        <footer className="mt-6 flex items-center gap-4 text-xs text-white/60">
          <span className="inline-flex items-center gap-1">
            <TrendingUp className="w-4 h-4" /> {post.vote_count}
          </span>
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="w-4 h-4" /> {post.comment_count}
          </span>
          <span className="inline-flex items-center gap-1">
            <Eye className="w-4 h-4" /> {post.view_count}
          </span>
          <span className="inline-flex items-center gap-1">
            <Share2 className="w-4 h-4" /> {post.share_count}
          </span>
        </footer>
      </article>
    </main>
  );
}
