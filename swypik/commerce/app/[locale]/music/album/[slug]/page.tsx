import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import { getAlbumBySlug } from "@/lib/music/repository";
import { safeJsonLd } from "@/lib/seo/json-ld";
import { languagesForMetadata, localizedUrl } from "@/lib/seo/hreflang";
import { APP_URL } from "@/lib/app-url";
import AlbumClient from "./AlbumClient";

export const dynamic = "force-dynamic";

type Props = {
    params: Promise<{ locale: string; slug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { slug, locale } = await params;
    let album = null;
    try {
        album = await getAlbumBySlug(slug);
    } catch {
        album = null;
    }

    if (!album) {
        return {
            title: "Album negăsit — Swypik Music",
            description: "Ascultă albume muzicale pe Swypik Music.",
        };
    }

    const title = `${album.title} - Album de ${album.artist.stage_name} | Swypik Music`;
    const description = `Ascultă albumul "${album.title}" lansat de ${album.artist.stage_name} pe Swypik Music. Redă toate piesele în sunet de înaltă fidelitate.`;
    const canonical = localizedUrl(locale, `/music/album/${slug}`);
    const languages = languagesForMetadata(`/music/album/${slug}`);

    return {
        title,
        description,
        alternates: { canonical, languages },
        openGraph: {
            title,
            description,
            type: "music.album",
            url: canonical,
            siteName: "Swypik Music",
            locale: "ro_RO",
            ...(album.cover_url
                ? {
                      images: [
                          {
                              url: album.cover_url,
                              width: 600,
                              height: 600,
                              alt: `${album.title} - ${album.artist.stage_name}`,
                          },
                      ],
                  }
                : {}),
        },
        twitter: {
            card: "summary_large_image",
            title,
            description,
            ...(album.cover_url ? { images: [album.cover_url] } : {}),
        },
    };
}

export default async function AlbumPage({ params }: Props) {
    if (!isEnabled("music")) notFound();
    const { slug } = await params;
    let album = null;
    try {
        album = await getAlbumBySlug(slug);
    } catch {
        album = null;
    }

    const jsonLd = album
        ? {
              "@context": "https://schema.org",
              "@type": "MusicAlbum",
              name: album.title,
              url: `${APP_URL}/music/album/${slug}`,
              image: album.cover_url || undefined,
              byArtist: {
                  "@type": "MusicGroup",
                  name: album.artist.stage_name,
                  url: `${APP_URL}/music/artist/${album.artist.slug}`,
              },
              publisher: {
                  "@type": "Organization",
                  name: "Swypik Music",
                  url: APP_URL,
              },
          }
        : null;

    return (
        <>
            {jsonLd && (
                <script
                    type="application/ld+json"
                    dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
                />
            )}
            <AlbumClient slug={slug} />
        </>
    );
}
