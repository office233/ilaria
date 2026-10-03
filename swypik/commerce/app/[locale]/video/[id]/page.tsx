/**
 * Video SEO Landing Page — Server Component
 *
 * URL-ul canonic al fiecărui clip (/video/:id, cu prefixul limbii în afara RO).
 * Metadate OpenGraph + Twitter pentru share, apoi redirect automat spre
 * /explore?v=:id (playerul real), în aceeași limbă.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { parseHashtags } from "@/lib/text/parseHashtags";
import { dbQuery } from "@/lib/db";
import { safeJsonLd } from "@/lib/seo/json-ld";
import { languagesForMetadata, localizedUrl } from "@/lib/seo/hreflang";
import { APP_URL } from "@/lib/app-url";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/config";
import { getPathname, Link, redirect } from "@/lib/i18n/navigation";
import { isUuidParam as isUuid } from "@/lib/validation/params";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";
import { OwnerVideoStatus, loadOwnerVideo } from "./OwnerVideoStatus";

type Props = { params: Promise<{ id: string; locale: string }> };

export const dynamic = "force-dynamic";

const OG_LOCALE: Record<Locale, string> = {
  ro: "ro_RO",
  en: "en_US",
  es: "es_ES",
  fr: "fr_FR",
  de: "de_DE",
  pt: "pt_PT",
  it: "it_IT",
};

/** Redirect-ul automat spre player (ms). */
const PLAYER_REDIRECT_MS = 1000;

type VideoRow = {
  id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  playback_url: string | null;
  duration_ms: number | null;
  view_count: number | string | null;
  published_at: string | null;
  creator_name: string | null;
};

function localeOf(raw: string): Locale {
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

// ── Shared fetch helper ─────────────────────────────────────────
async function getVideo(id: string): Promise<VideoRow | null> {
  // Id invalid → fără interogare (altfel 22P02 pe cast-ul uuid).
  if (!isUuid(id)) return null;
  try {
    const { rows } = await dbQuery<VideoRow>(
      `SELECT v.id, v.title, v.description, v.thumbnail_url, v.playback_url,
              v.duration_ms, v.view_count, v.published_at,
              u.display_name AS creator_name
       FROM videos v
       JOIN users u ON v.creator_id = u.id
       WHERE v.id = $1
         AND v.status = 'ready'
         AND v.visibility = 'public'
         AND COALESCE(v.is_hidden, false) = false
         AND v.effective_label = 'safe'`,
      [id],
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

/** Tipul MIME al URL-ului de redare (HLS vs MP4). */
function videoMime(url: string): string {
  return /\.m3u8(\?|$)/i.test(url) ? "application/x-mpegURL" : "video/mp4";
}

function canonicalFor(id: string, locale: Locale): string {
  return localizedUrl(locale, `/video/${id}`);
}

// ── Metadata ────────────────────────────────────────────────────
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id, locale: rawLocale } = await params;
  const locale = localeOf(rawLocale);
  const t = await getTranslations({ locale, namespace: "video" });
  const video = await getVideo(id);

  if (!video) {
    return { title: t("videoNotFoundTitle"), robots: { index: false } };
  }

  const rawCreator = (video.creator_name || "").trim();
  const isGenericCreator = !rawCreator || /^(swypik|swypik\s*system|system|bot|admin)$/i.test(rawCreator);
  const creatorSuffix = isGenericCreator ? "" : ` ${t("byCreator", { name: rawCreator })}`;
  const title = `${video.title}${creatorSuffix} — Swypik`;
  const description = video.description
    ? video.description.replace(/<[^>]*>/g, " ").trim().slice(0, 155)
    : t("watchOnSwypik", { title: video.title });

  const canonical = canonicalFor(id, locale);
  const languages = languagesForMetadata(`/video/${id}`);
  return {
    title,
    description,
    alternates: { canonical, languages },
    openGraph: {
      title: video.title,
      description,
      type: "video.other",
      url: canonical,
      siteName: "Swypik",
      locale: OG_LOCALE[locale],
      ...(video.playback_url
        ? {
            videos: [
              {
                url: video.playback_url,
                type: videoMime(video.playback_url),
                ...(video.duration_ms ? { duration: Math.round(video.duration_ms / 1000) } : {}),
              },
            ],
          }
        : {}),
      ...(video.thumbnail_url ? { images: [{ url: video.thumbnail_url, width: 720, height: 1280 }] } : {}),
    },
    // `player` cere un URL de player embeddable (nu avem) → card mare cu imagine.
    twitter: {
      card: "summary_large_image",
      title: video.title,
      description,
      ...(video.thumbnail_url ? { images: [video.thumbnail_url] } : {}),
    },
  };
}

// ── Page Component ──────────────────────────────────────────────
export default async function VideoPage({ params }: Props) {
  const { id, locale: rawLocale } = await params;
  const locale = localeOf(rawLocale);
  if (!isUuid(id)) notFound();
  const t = await getTranslations({ locale, namespace: "video" });
  const video = await getVideo(id);

  if (!video) {
    // Autorul vede starea clipului (procesare / review / programat), nu un redirect în gol.
    const own = await loadOwnerVideo(id);
    if (own) return <OwnerVideoStatus video={own} />;
    return redirect({ href: "/explore", locale });
  }

  const creatorLabel = video.creator_name || t("creatorFallback");
  const formattedViews = Number(video.view_count || 0).toLocaleString(locale);
  const playerHref = { pathname: "/explore", query: { v: id } } as const;
  const playerPath = getPathname({ href: playerHref, locale });
  const breadcrumbBase = languagesForMetadata("/")[locale] ?? `${APP_URL}/`;

  return (
    <>
      {/* JSON-LD for VideoObject structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd({
            "@context": "https://schema.org",
            "@type": "VideoObject",
            name: video.title,
            description: video.description || video.title,
            thumbnailUrl: video.thumbnail_url,
            contentUrl: video.playback_url,
            uploadDate: video.published_at ? new Date(video.published_at).toISOString() : undefined,
            duration: video.duration_ms
              ? `PT${Math.floor(video.duration_ms / 60000)}M${Math.floor((video.duration_ms % 60000) / 1000)}S`
              : undefined,
            inLanguage: locale,
            interactionStatistic: {
              "@type": "InteractionCounter",
              interactionType: { "@type": "WatchAction" },
              userInteractionCount: Number(video.view_count || 0),
            },
            author: { "@type": "Person", name: creatorLabel },
          }),
        }}
      />

      {/* Breadcrumb JSON-LD */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: t("breadcrumbHome"), item: breadcrumbBase },
              {
                "@type": "ListItem",
                position: 2,
                name: t("breadcrumbExplore"),
                item: languagesForMetadata("/explore")[locale],
              },
              { "@type": "ListItem", position: 3, name: (video.title || t("breadcrumbVideo")).slice(0, 80), item: canonicalFor(id, locale) },
            ],
          }),
        }}
      />

      {/* Redirect automat spre player, în limba paginii. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `setTimeout(function(){window.location.href=${JSON.stringify(playerPath)}},${PLAYER_REDIRECT_MS});`,
        }}
      />

      {/* SEO landing page — visible to crawlers & slow connections */}
      <ImmersiveSurface className="flex items-center justify-center bg-gradient-to-br from-canvas via-brand-soft to-canvas px-gutter pt-safe-t pb-safe-b">
        <div className="w-full max-w-[420px] py-6 text-center">
          {video.thumbnail_url && (
            <div className="relative mx-auto mb-6 aspect-[9/16] max-h-[480px] overflow-hidden rounded-sheet shadow-xl ring-1 ring-fg/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={video.thumbnail_url} alt={video.title} className="block h-full w-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-overlay/70" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-brand/90 shadow-lg backdrop-blur">
                  <svg width="32" height="32" viewBox="0 0 24 24" className="ml-[3px] fill-brand-fg" aria-hidden>
                    <polygon points="5,3 19,12 5,21" />
                  </svg>
                </div>
              </div>
            </div>
          )}

          <h1 className="mb-2 text-xl font-bold leading-snug tracking-tight">{parseHashtags(video.title)}</h1>

          <p className="mb-1.5 text-sm text-fg-muted">
            {t("byCreatorPrefix")} <span className="font-semibold text-brand">{creatorLabel}</span>
          </p>

          <p className="mb-4 text-xs text-fg-subtle">
            {formattedViews} {t("vizualizari")}
          </p>

          {video.description && (
            <p className="mb-6 text-left text-sm leading-relaxed text-fg-muted">{parseHashtags(video.description)}</p>
          )}

          <Link
            href={playerHref}
            className="inline-flex items-center gap-2.5 rounded-control bg-brand px-9 py-3.5 text-base font-bold text-brand-fg shadow-lg transition-transform active:scale-95"
          >
            <span aria-hidden className="text-xl">▶</span> {t("vizioneaza")}
          </Link>

          <p className="mt-5 text-xs text-fg-subtle">{t("redirectionareAutomata")}</p>
        </div>
      </ImmersiveSurface>
    </>
  );
}
