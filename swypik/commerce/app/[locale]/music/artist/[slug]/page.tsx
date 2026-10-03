import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import { getArtistBySlug } from "@/lib/music/repository";
import { safeJsonLd } from "@/lib/seo/json-ld";
import { languagesForMetadata, localizedUrl } from "@/lib/seo/hreflang";
import { APP_URL } from "@/lib/app-url";
import ArtistClient from "./ArtistClient";

export const dynamic = "force-dynamic";

type Props = {
    params: Promise<{ locale: string; slug: string }>;
};

async function resolveArtist(slug: string) {
    let dbArtist = null;
    try {
        dbArtist = await getArtistBySlug(slug);
    } catch {
        dbArtist = null;
    }

    if (dbArtist) {
        return {
            slug: dbArtist.slug,
            stageName: dbArtist.stage_name,
            bio: dbArtist.bio,
            avatarUrl: dbArtist.avatar_url,
            coverUrl: dbArtist.cover_url,
        };
    }

    // Fallback artist necunoscut din slug
    const artistName = slug
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

    return {
        slug,
        stageName: artistName,
        bio: `Ascultă piese și albume de la ${artistName} pe Swypik Music.`,
        avatarUrl: null,
        coverUrl: null,
    };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { slug, locale } = await params;
    const artist = await resolveArtist(slug);

    if (!artist) {
        return {
            title: "Artist negăsit — Swypik Music",
            description: "Descoperă artiști și muzică pe Swypik Music.",
        };
    }

    const title = `${artist.stageName} - Piese, Albume și Melodii | Swypik Music`;
    const description = `Ascultă cele mai bune melodii și piese muzicale lansate de ${artist.stageName} pe Swypik Music. Descoperă discografia și noutățile artistului.`;
    const canonical = localizedUrl(locale, `/music/artist/${slug}`);
    const languages = languagesForMetadata(`/music/artist/${slug}`);
    const image = artist.avatarUrl || artist.coverUrl;

    return {
        title,
        description,
        alternates: { canonical, languages },
        openGraph: {
            title,
            description,
            type: "profile",
            url: canonical,
            siteName: "Swypik Music",
            locale: "ro_RO",
            ...(image
                ? {
                      images: [
                          {
                              url: image,
                              width: 600,
                              height: 600,
                              alt: artist.stageName,
                          },
                      ],
                  }
                : {}),
        },
        twitter: {
            card: "summary_large_image",
            title,
            description,
            ...(image ? { images: [image] } : {}),
        },
    };
}

export default async function ArtistPage({ params }: Props) {
    if (!isEnabled("music")) notFound();
    const { slug } = await params;
    const artist = await resolveArtist(slug);

    const jsonLd = artist
        ? {
              "@context": "https://schema.org",
              "@type": "MusicGroup",
              name: artist.stageName,
              url: `${APP_URL}/music/artist/${slug}`,
              image: artist.avatarUrl || artist.coverUrl || undefined,
              description: artist.bio || `Melodii și piese populare de la ${artist.stageName} pe Swypik Music.`,
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
            <ArtistClient slug={slug} />
        </>
    );
}
