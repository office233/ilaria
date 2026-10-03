import type { AudioItemDto } from "./types";
import { isSecureStreamUrl } from "./license";

interface ITunesEpisode {
    trackId?: number;
    collectionId?: number;
    trackName?: string;
    artistName?: string;
    collectionName?: string;
    artworkUrl600?: string;
    artworkUrl100?: string;
    episodeUrl?: string;
    previewUrl?: string;
    trackTimeMillis?: number;
    releaseDate?: string;
    primaryGenreName?: string;
}

interface ITunesResponse {
    resultCount: number;
    results: ITunesEpisode[];
}

// Curated Top Romanian & Global podcasts for Swypik Audio Tab 4
export const CURATED_PODCAST_SHOWS = [
    {
        name: "Mind Architect",
        term: "Mind Architect",
        country: "ro",
        artist: "Mind Architect",
        cover: "https://is1-ssl.mzstatic.com/image/thumb/Podcasts116/v4/31/ff/45/31ff4560-6c99-733d-c1bc-9e583cbe5a86/mza_10332847124316045610.jpg/600x600bb.jpg",
    },
    {
        name: "Recorder Podcast",
        term: "Recorder Romania",
        country: "ro",
        artist: "Recorder",
        cover: "https://is1-ssl.mzstatic.com/image/thumb/Podcasts125/v4/ce/20/cf/ce20cf4c-f1e1-e123-5e76-37b587eb09ae/mza_16694602287232230182.jpg/600x600bb.jpg",
    },
    {
        name: "IGDLCC",
        term: "George Buhnici IGDLCC",
        country: "ro",
        artist: "George Buhnici",
        cover: "https://is1-ssl.mzstatic.com/image/thumb/Podcasts125/v4/91/33/c4/9133c448-b4b1-80a5-f43c-fc02a9e3dd09/mza_8314995256249767746.jpg/600x600bb.jpg",
    },
    {
        name: "Huberman Lab",
        term: "Huberman Lab",
        country: "us",
        artist: "Dr. Andrew Huberman",
        cover: "https://is1-ssl.mzstatic.com/image/thumb/Podcasts116/v4/0d/bb/00/0dbb00f7-1d22-1d54-8e10-917ec7fe86c6/mza_14624792610515159030.jpg/600x600bb.jpg",
    },
    {
        name: "Lex Fridman Podcast",
        term: "Lex Fridman Podcast",
        country: "us",
        artist: "Lex Fridman",
        cover: "https://is1-ssl.mzstatic.com/image/thumb/Podcasts113/v4/44/2c/3e/442c3ec7-8d2b-656b-a255-a22a36b32ee1/mza_10313886561578332924.jpg/600x600bb.jpg",
    },
    {
        name: "TED Talks Daily",
        term: "TED Talks Daily",
        country: "us",
        artist: "TED",
        cover: "https://is1-ssl.mzstatic.com/image/thumb/Podcasts115/v4/f4/b7/df/f4b7df1b-b4a1-0db3-b40b-41712a43cf47/mza_14272186794553255955.jpg/600x600bb.jpg",
    }
];

const FETCH_TIMEOUT_MS = 5_000;

export async function fetchPodcastEpisodes(term: string, country = "ro", limit = 10): Promise<AudioItemDto[]> {
    try {
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=podcast&entity=podcastEpisode&country=${country}&limit=${limit}`;
        const res = await fetch(url, {
            headers: {
                "Accept": "application/json",
                "User-Agent": "SwypikAudio/1.0",
            },
            next: { revalidate: 3600 },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!res.ok) {
            return [];
        }

        const data = (await res.json()) as ITunesResponse;
        if (!data.results || !Array.isArray(data.results)) {
            return [];
        }

        return data.results
            .filter((ep) => isSecureStreamUrl(ep.episodeUrl || ep.previewUrl))
            .map((ep) => {
                const streamUrl = ep.episodeUrl || ep.previewUrl || "";
                const id = `podcast-${ep.trackId || Math.random().toString(36).substring(2, 9)}`;
                return {
                    id,
                    slug: id,
                    title: ep.trackName || "Episod Podcast",
                    artist: ep.artistName || ep.collectionName || "Podcast",
                    coverUrl: ep.artworkUrl600 || ep.artworkUrl100 || null,
                    streamUrl,
                    durationMs: ep.trackTimeMillis || 0,
                    genre: ep.primaryGenreName || "Podcast",
                    source: "podcast",
                    isLive: false,
                };
            });
    } catch {
        return [];
    }
}

export async function getTrendingPodcasts(): Promise<AudioItemDto[]> {
    // Emisiunile în paralel (erau secvențiale: N × latența iTunes pe calea cererii).
    const perShow = await Promise.all(
        CURATED_PODCAST_SHOWS.map((show) => fetchPodcastEpisodes(show.term, show.country, 3).catch(() => [])),
    );
    return perShow.flat();
}
