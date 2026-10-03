/**
 * Public Arena post page — /b/[slug]
 *
 * Server-rendered, no auth required. Mobile-first, share-optimized.
 * OG image generated dynamically in opengraph-image.tsx in the same folder.
 */
import { notFound } from "next/navigation";
import { Link } from "@/lib/i18n/navigation";
import NextLink from "next/link";
import type { Metadata } from "next";
import { dbQuery } from "@/lib/db";
import { languagesForMetadata, localizedUrl } from "@/lib/seo/hreflang";
import { getTranslations } from "next-intl/server";

type PostMeta = {
  id: string;
  slug: string;
  format: string;
  title: string;
  body: string | null;
  vote_count: number;
  comment_count: number;
  share_count: number;
  view_count: number;
  ends_at: string | null;
  author_handle: string | null;
  author_display: string | null;
  author_avatar: string | null;
};

type OptionRow = {
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

async function loadPost(slug: string) {
  const { rows } = await dbQuery<PostMeta>(
    `SELECT
       p.id, p.slug, p.format, p.title, p.body,
       p.vote_count, p.comment_count, p.share_count, p.view_count,
       p.ends_at,
       u.username AS author_handle,
       u.display_name AS author_display,
       u.avatar_url AS author_avatar
     FROM community_posts p
     LEFT JOIN users u ON u.id = p.author_user_id
     WHERE p.slug = $1 AND p.status='active' AND p.is_adult=FALSE
     LIMIT 1`,
    [slug],
  );
  const post = rows[0];
  if (!post) return null;
  const { rows: opts } = await dbQuery<OptionRow>(
    `SELECT i.option_key, i.label, i.vote_count, i.position,
            i.product_id, mp.title AS product_title,
            mp.image_url AS product_image,
            mp.price_cents AS product_price_minor, mp.currency AS product_currency,
            i.external_url, i.external_image, i.external_title
     FROM community_post_items i
     LEFT JOIN marketplace_products mp ON mp.id = i.product_id
     WHERE i.post_id = $1
     ORDER BY i.position`,
    [post.id],
  );
  return { post, options: opts };
}

const FORMAT_CTA: Record<string, string> = {
  find_me: "Ajută-mă să aleg",
  merita: "Merită sau nu?",
  dupe_hunt: "Găseşte o alternativă mai bună",
  roast_cart: "Bate-mi coşul",
  drop: "Vezi drop-ul",
  setup: "Vezi setup-ul",
  review_real: "Citeşte review-ul real",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}): Promise<Metadata> {
  const { slug, locale } = await params;
  const loaded = await loadPost(slug);
  if (!loaded) return { title: "Post negăsit · Swypik" };
  const { post } = loaded;
  const cta = FORMAT_CTA[post.format] ?? "Vezi pe Swypik";
  const title = `${cta}: ${post.title}`;
  const description = post.body?.slice(0, 160) || `${cta} pe Swypik — comunitatea decide.`;
  const url = localizedUrl(locale, `/b/${post.slug}`);
  return {
    title,
    description,
    alternates: { canonical: url, languages: languagesForMetadata(`/b/${post.slug}`) },
    openGraph: {
      title,
      description,
      url,
      siteName: "Swypik",
      type: "article",
      locale: "ro_RO",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function PublicPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const t = await getTranslations("b");
  const { slug } = await params;
  const loaded = await loadPost(slug);
  if (!loaded) notFound();
  const { post, options } = loaded;

  const totalVotes = options.reduce((s, o) => s + (o.vote_count || 0), 0);
  const cta = FORMAT_CTA[post.format] ?? "Vezi pe Swypik";

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-50">
      <div className="mx-auto max-w-xl px-4 py-6">
        <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-100">
          ← Swypik
        </Link>

        <header className="mt-4 flex items-center gap-3">
          {post.author_avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={post.author_avatar}
              alt=""
              className="h-10 w-10 rounded-full object-cover"
            />
          ) : (
            <div className="h-10 w-10 rounded-full bg-zinc-800" />
          )}
          <div className="text-sm">
            <div className="font-medium">{post.author_display ?? post.author_handle ?? "Anonim"}</div>
            {post.author_handle ? (
              <div className="text-zinc-400">@{post.author_handle}</div>
            ) : null}
          </div>
          <span className="ml-auto rounded-full bg-violet-600/20 px-3 py-1 text-xs font-semibold text-violet-300">
            {post.format.toUpperCase()}
          </span>
        </header>

        <h1 className="mt-5 text-2xl font-semibold leading-tight">{post.title}</h1>
        {post.body ? (
          <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-300">{post.body}</p>
        ) : null}

        <div className="mt-6 space-y-3">
          {options.map((opt) => {
            const title = opt.product_title || opt.external_title || opt.label || opt.option_key;
            const image = opt.product_image || opt.external_image;
            const percent = totalVotes > 0 ? Math.round((opt.vote_count * 100) / totalVotes) : 0;
            return (
              <div
                key={opt.option_key}
                className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900"
              >
                <div className="flex items-center gap-3 p-3">
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={image} alt="" className="h-16 w-16 rounded-lg object-cover" />
                  ) : (
                    <div className="h-16 w-16 rounded-lg bg-zinc-800" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{title}</div>
                    {opt.label ? (
                      <div className="truncate text-xs text-zinc-400">{opt.label}</div>
                    ) : null}
                    <div className="mt-1 text-xs text-zinc-400">
                      {opt.vote_count} vot{opt.vote_count === 1 ? "" : "uri"} · {percent}%
                    </div>
                  </div>
                </div>
                <div className="h-1.5 w-full bg-zinc-800">
                  <div
                    className="h-full bg-violet-500 transition-all"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-8 rounded-2xl bg-violet-600 px-5 py-4 text-center">
          <p className="text-sm opacity-90">
            {totalVotes} vot{totalVotes === 1 ? "" : "uri"}  {t("panaAcum")}
          </p>
          <NextLink
            href={`/auth/signup?next=/b/${post.slug}`}
            className="mt-2 inline-block rounded-full bg-white px-6 py-2 font-semibold text-violet-700"
          >
            {cta}  {t("peSwypik")}
          </NextLink>
        </div>

        <p className="mt-6 text-center text-xs text-zinc-500">

          {t("swypikSocialShoppingUnde")}
        </p>
      </div>
    </main>
  );
}
