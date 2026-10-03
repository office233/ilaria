import { Link } from "@/lib/i18n/navigation";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Star } from "lucide-react";
import { searchAll } from "@/lib/search/query";
import SearchBar from "@/components/search/SearchBar";
import { formatCurrency } from "@/lib/i18n/currency";
import { getProductRatingMap } from "@/lib/reviews/aggregate";
import { getTranslations } from "next-intl/server";
import {
  CURRENCY_COOKIE,
  LOCALE_COOKIE,
  isCurrency,
  isLocale,
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
} from "@/lib/i18n/config";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

type SearchParams = { q?: string; tab?: string };

const ACCENT = "#7C3AED";
const BG = "#0D0D0D";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "searchPage" });
  return { title: t("title"), alternates: localizedAlternates(locale, "/search") };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params: SearchParams = await searchParams;
  const t = await getTranslations("searchPage");

  const q = (params.q ?? "").trim();
  const tab = (params.tab ?? "videos") as "videos" | "creators" | "products" | "hashtags";

  const cookieStore = await cookies();
  const cCurr = cookieStore.get(CURRENCY_COOKIE)?.value;
  const cLoc = cookieStore.get(LOCALE_COOKIE)?.value;
  const displayCurrency = isCurrency(cCurr) ? cCurr : DEFAULT_CURRENCY;
  const locale = isLocale(cLoc) ? cLoc : DEFAULT_LOCALE;
  const fmt = (cents: number | null | undefined) =>
    cents == null
      ? ""
      : formatCurrency(cents, { locale, displayCurrency, sourceCurrency: "RON" });

  const tooShort = q.length < 2;
  const results = tooShort
    ? { videos: [], creators: [], products: [], hashtags: [] }
    : await searchAll(q).catch(() => ({
      videos: [],
      creators: [],
      products: [],
      hashtags: [],
    }));

  // Batched aggregate fetch for product cards — single query, no N+1.
  const productIds = results.products.map((p) => String(p.id));
  const ratingMap =
    productIds.length > 0
      ? await getProductRatingMap(productIds)
      : new Map<string, { avgRating: number; reviewCount: number }>();

  const tabs: Array<{ key: typeof tab; label: string; count: number }> = [
    { key: "videos", label: t("tabVideos"), count: results.videos.length },
    { key: "creators", label: t("tabCreators"), count: results.creators.length },
    { key: "products", label: t("tabProducts"), count: results.products.length },
    { key: "hashtags", label: t("tabHashtags"), count: results.hashtags.length },
  ];

  return (
    <main className="min-h-screen overflow-x-hidden text-white" style={{ backgroundColor: BG }}>
      <div className="mx-auto max-w-5xl min-w-0 px-4 py-6 pb-[max(24px,env(safe-area-inset-bottom))]">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold mb-4">{t("title")}</h1>
          <SearchBar initialQuery={q} />
        </header>

        {tooShort ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-8 text-center text-neutral-400">
            {t("minChars")}
          </div>
        ) : (
          <>
            <nav className="-mx-4 mb-6 overflow-x-auto border-b border-neutral-800 px-4">
              <div className="flex min-w-full w-max gap-1">
                {tabs.map((t) => {
                  const active = t.key === tab;
                  const href = `/search?q=${encodeURIComponent(q)}&tab=${t.key}`;
                  return (
                    <Link
                      key={t.key}
                      href={href}
                      className="inline-flex shrink-0 items-center whitespace-nowrap px-4 py-3 min-h-[44px] text-sm font-medium border-b-2 transition-colors focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none"
                      style={{
                        borderColor: active ? ACCENT : "transparent",
                        color: active ? ACCENT : "#d4d4d4",
                      }}
                    >
                      {t.label} <span className="text-neutral-500">({t.count})</span>
                    </Link>
                  );
                })}
              </div>
            </nav>

            {tab === "videos" && (
              <section>
                {results.videos.length === 0 ? (
                  <EmptyState label={t("noVideosFor", { query: q })} />
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {results.videos.map((v) => (
                      <Link
                        key={v.id}
                        href={`/video/${v.id}`}
                        className="group rounded-lg overflow-hidden bg-neutral-900 border border-neutral-800 hover:border-[#7C3AED] transition-colors"
                      >
                        <div className="aspect-[9/16] bg-neutral-800 relative">
                          {v.thumbnail_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={v.thumbnail_url} alt={v.title ?? ""} className="w-full h-full object-cover" />
                          ) : null}
                        </div>
                        <div className="p-2">
                          <div className="text-sm font-medium truncate">{v.title ?? t("untitled")}</div>
                          <div className="text-xs text-neutral-400 truncate">
                            {v.creator_name ?? "—"} · {t("likesCount", { count: Intl.NumberFormat().format(v.like_count) })}
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </section>
            )}

            {tab === "creators" && (
              <section>
                {results.creators.length === 0 ? (
                  <EmptyState label={t("noCreatorsFor", { query: q })} />
                ) : (
                  <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800 bg-neutral-900/40">
                    {results.creators.map((c) => (
                      <li key={c.id}>
                        <Link href={`/u/${c.username ?? c.id}`} className="flex items-center gap-3 p-3 hover:bg-neutral-900">
                          <div className="w-12 h-12 rounded-full bg-neutral-800 overflow-hidden flex-shrink-0">
                            {c.avatar_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={c.avatar_url} alt={c.username ?? ""} className="w-full h-full object-cover" />
                            ) : null}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="font-medium truncate">{c.display_name || c.username || t("creatorFallback")}</div>
                            <div className="text-xs text-neutral-400 truncate">
                              @{c.username ?? t("unknownHandle")} · {t("followersCount", { count: Intl.NumberFormat().format(c.follower_count) })}
                            </div>
                            {c.bio ? <div className="text-xs text-neutral-500 truncate mt-1">{c.bio}</div> : null}
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {tab === "products" && (
              <section>
                {results.products.length === 0 ? (
                  <EmptyState label={t("noProductsFor", { query: q })} />
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {results.products.map((p) => {
                      const agg = ratingMap.get(String(p.id));
                      return (
                        <Link
                          key={p.id}
                          href={`/product/${p.id}`}
                          className="group rounded-lg overflow-hidden bg-neutral-900 border border-neutral-800 hover:border-[#7C3AED] transition-colors"
                        >
                          <div className="aspect-square bg-neutral-800 relative">
                            {p.image_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={p.image_url} alt={p.title ?? ""} className="w-full h-full object-cover" />
                            ) : null}
                            {agg && agg.reviewCount > 0 && (
                              <span
                                className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/80 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm"
                                aria-label={t("ratingAriaLabel", { rating: agg.avgRating.toFixed(1), count: agg.reviewCount })}
                                title={t("ratingTitle", { rating: agg.avgRating.toFixed(1), count: agg.reviewCount })}
                              >
                                <Star size={10} className="text-[#F59E0B]" fill="currentColor" />
                                {agg.avgRating.toFixed(1)}
                                <span className="text-white/60">({agg.reviewCount})</span>
                              </span>
                            )}
                          </div>
                          <div className="p-2">
                            <div className="text-sm font-medium truncate">{p.title ?? t("productFallback")}</div>
                            <div className="text-sm font-semibold mt-1" style={{ color: ACCENT }}>
                              {fmt(p.price_cents)}
                            </div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {tab === "hashtags" && (
              <section>
                {results.hashtags.length === 0 ? (
                  <EmptyState label={t("noHashtagsFor", { query: q })} />
                ) : (
                  <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800 bg-neutral-900/40">
                    {results.hashtags.map((h) => (
                      <li key={h.tag}>
                        <Link href={`/hashtag/${encodeURIComponent(h.tag)}`} className="flex items-center gap-3 p-4 hover:bg-neutral-900">
                          <div className="w-12 h-12 rounded-full bg-neutral-800 flex items-center justify-center text-xl font-bold flex-shrink-0">#</div>
                          <div className="min-w-0 flex-1">
                            <div className="font-medium truncate">#{h.tag}</div>
                            <div className="text-xs text-neutral-400">{t("videosCount", { count: Intl.NumberFormat().format(h.video_count) })}</div>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-8 text-center text-neutral-400">
      {label}
    </div>
  );
}
