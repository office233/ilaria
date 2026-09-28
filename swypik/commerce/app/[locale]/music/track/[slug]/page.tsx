import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isEnabled } from "@/lib/feature-flags";
import { resolvePublishedTrack } from "@/lib/music/track-page";
import { safeJsonLd } from "@/lib/seo/json-ld";
import { languagesForMetadata, localizedUrl } from "@/lib/seo/hreflang";
import { APP_URL } from "@/lib/app-url";
import TrackClient from "./TrackClient";

export const dynamic = "force-dynamic";

type Props = {
    params: Promise<{ locale: string; slug: string }>;
};

/** Dimensiunea declarată a copertei (pătrată) în Open Graph. */
const OG_COVER_PX = 600;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale, slug } = await params;
    const t = await getTranslations({ locale, namespace: "music" });
    const track = await resolvePublishedTrack(slug);
    if (!track) return { title: t("trackNotFoundTitle"), robots: { index: false } };

    const title = `${track.title} - ${track.artist.stageName} | ${t("title")}`;
    const description = t("trackMetaDescription", { title: track.title, artist: track.artist.stageName });
    const canonical = localizedUrl(locale, `/music/track/${slug}`);
    const languages = languagesForMetadata(`/music/track/${slug}`);

    return {
        title,
        description,
        alternates: { canonical, languages },
        openGraph: {
            title,
            description,
            type: "music.song",
            url: canonical,
            siteName: t("title"),
            locale,
            ...(track.coverUrl
                ? { images: [{ url: track.coverUrl, width: OG_COVER_PX, height: OG_COVER_PX, alt: `${track.title} - ${track.artist.stageName}` }] }
                : {}),
        },
        twitter: { card: "summary_large_image", title, description, ...(track.coverUrl ? { images: [track.coverUrl] } : {}) },
    };
}

export default async function TrackPage({ params }: Props) {
    if (!isEnabled("music")) notFound();
    const { locale, slug } = await params;
    const track = await resolvePublishedTrack(slug);
    if (!track) notFound();

    const minutes = Math.floor(track.durationMs / 60000);
    const seconds = Math.floor((track.durationMs % 60000) / 1000);
    const t = await getTranslations({ locale, namespace: "music" });
    const jsonLd = {
        "@context": "https://schema.org",
        "@type": "MusicRecording",
        name: track.title,
        url: `${APP_URL}/music/track/${slug}`,
        image: track.coverUrl || undefined,
        duration: `PT${minutes}M${seconds}S`,
        genre: track.genre,
        byArtist: { "@type": "MusicGroup", name: track.artist.stageName, url: `${APP_URL}/music/artist/${track.artist.slug}` },
        inLanguage: locale,
        publisher: { "@type": "Organization", name: t("title"), url: APP_URL },
    };

    return (
        <>
            <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }} />
            <TrackClient slug={slug} />
        </>
    );
}
