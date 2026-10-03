"use client";

/**
 * Pagina publică a unui artist: copertă (cu fallback pe avatar blurat),
 * avatar, nume în fontul de afișare, badge „oficial", bio, Play all / Shuffle /
 * Susține (TipSheet), statistica de reels și cele două secțiuni — albume și
 * piese. Mirror-uiește structura `app/[locale]/movies/[slug]/SeriesClient.tsx`.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Play, Shuffle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import TrackRow from "@/components/music/TrackRow";
import { useMusicPlayer } from "@/components/music/MusicPlayerProvider";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import { moviesDisplayFont, MOVIES_DISPLAY_CLASS } from "@/components/movies/fonts";
import { haptic } from "@/lib/haptic";
import type { AlbumDto, ArtistDto, TrackDto } from "@/lib/music/types";
import AddToPlaylistSheet from "../../_components/AddToPlaylistSheet";
import LockedOverlay from "../../_components/LockedOverlay";
import { setTrackLiked, shuffleTracks } from "../../_lib/track-actions";

type Payload = { artist: ArtistDto; tracks: TrackDto[]; albums: AlbumDto[]; reelsCount: number };

export default function ArtistClient({ slug }: { slug: string }) {
    const t = useTranslations("music");
    const formatPrice = useFormatPrice();
    const { play } = useMusicPlayer();
    const [data, setData] = useState<Payload | null>(null);
    const [notFoundState, setNotFoundState] = useState(false);
    const [error, setError] = useState(false);
    const [playlistTarget, setPlaylistTarget] = useState<TrackDto | null>(null);

    const load = useCallback(() => {
        fetch(`/api/music/artists/${slug}`, { cache: "no-store" })
            .then((r) => {
                if (r.status === 404) { setNotFoundState(true); return null; }
                if (!r.ok) return Promise.reject(r.status);
                return r.json();
            })
            .then((d: Payload | null) => { if (d) setData(d); })
            .catch(() => setError(true));
    }, [slug]);
    useEffect(load, [load]);

    const toggleLike = async (track: TrackDto) => {
        if (!data) return;
        const next = !track.liked;
        setData({ ...data, tracks: data.tracks.map((tr) => (tr.id === track.id ? { ...tr, liked: next } : tr)) });
        const ok = await setTrackLiked(track.slug, next);
        if (!ok) setData((prev) => (prev ? { ...prev, tracks: prev.tracks.map((tr) => (tr.id === track.id ? { ...tr, liked: track.liked } : tr)) } : prev));
    };

    if (error) return <div className="flex min-h-screen items-center justify-center bg-[#0B0B12] text-white/70">{t("loadError")}</div>;
    if (notFoundState) return <div className="flex min-h-screen items-center justify-center bg-[#0B0B12] text-white/70">{t("empty")}</div>;
    if (!data) return <div className="min-h-screen bg-[#0B0B12]" />;

    const { artist, tracks, albums, reelsCount } = data;
    const coverSrc = artist.coverUrl ?? artist.avatarUrl;

    return (
        <main className={`${moviesDisplayFont.variable} min-h-screen bg-[#0B0B12] pb-24 text-white`}>
            <header className="fixed inset-x-0 top-0 z-30 flex items-center gap-3 bg-gradient-to-b from-black/90 to-transparent px-4 pb-3" style={{ paddingTop: "max(10px, env(safe-area-inset-top))" }}>
                <Link href="/music" aria-label={t("back")} className="rounded-full bg-black/40 p-2 ring-1 ring-white/15"><ArrowLeft size={18} /></Link>
            </header>

            <section className="relative h-[38vh] w-full overflow-hidden bg-black">
                {coverSrc && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={coverSrc} alt="" className="scale-110 object-cover opacity-50 blur-2xl h-full w-full" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-[#0B0B12] via-black/30 to-black/40" />
            </section>

            <section className="-mt-14 px-5">
                <div className="relative h-28 w-28 overflow-hidden rounded-full bg-white/10 shadow-2xl ring-4 ring-[#0B0B12]">
                    {artist.avatarUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={artist.avatarUrl} alt={artist.stageName} className="object-cover h-full w-full" />
                    )}
                </div>
                <div className="mt-3 flex items-center gap-2">
                    <h1 className={`${MOVIES_DISPLAY_CLASS} truncate text-4xl leading-[0.95] text-white`}>{artist.stageName}</h1>
                    {artist.isOfficial && (
                        <span className={`${MOVIES_DISPLAY_CLASS} rounded bg-[#7C3AED] px-2 py-0.5 text-xs tracking-wider text-white`}>{t("official")}</span>
                    )}
                </div>
                {artist.bio && (
                    <div className="mt-2">
                        <p className="text-xs font-bold uppercase tracking-wide text-white/40">{t("about")}</p>
                        <p className="mt-1 text-sm leading-relaxed text-white/80">{artist.bio}</p>
                    </div>
                )}
                <p className="mt-2 text-xs text-white/50">{t("reelsUsing", { count: reelsCount })}</p>

                <div className="mt-4 flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={() => { haptic("tap"); if (tracks.length > 0) play(tracks, 0); }}
                        disabled={tracks.length === 0}
                        className="flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-black text-black active:scale-95 disabled:opacity-40"
                    >
                        <Play size={18} fill="currentColor" /> {t("playAll")}
                    </button>
                    <button
                        type="button"
                        onClick={() => { haptic("tap"); if (tracks.length > 0) play(shuffleTracks(tracks), 0); }}
                        disabled={tracks.length === 0}
                        className="flex items-center gap-2 rounded-full bg-white/10 px-5 py-2.5 text-sm font-black text-white ring-1 ring-white/20 active:scale-95 disabled:opacity-40"
                    >
                        <Shuffle size={18} /> {t("shuffle")}
                    </button>
                </div>
            </section>

            {albums.length > 0 && (
                <section className="mt-8 px-5">
                    <h2 className="mb-3 text-[15px] font-bold text-white/90">{t("albums")}</h2>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {albums.map((album) => (
                            <Link key={album.id} href={`/music/album/${album.slug}`} className="group block active:scale-95">
                                <div className="relative aspect-square overflow-hidden rounded-xl bg-white/10 ring-1 ring-white/10">
                                    {album.coverUrl ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={album.coverUrl} alt={album.title} className="h-full w-full object-cover" />
                                    ) : (
                                        <div className="absolute inset-0 bg-gradient-to-b from-white/10 to-black" />
                                    )}
                                </div>
                                <p className="mt-1.5 truncate text-[13px] font-bold text-white">{album.title}</p>
                                {album.priceCents !== null && (
                                    <p className="truncate text-[11px] text-[#A78BFA]">{formatPrice(album.priceCents, { sourceCurrency: "RON" })}</p>
                                )}
                            </Link>
                        ))}
                    </div>
                </section>
            )}

            <section className="mt-8">
                <h2 className="mb-1 px-5 text-[15px] font-bold text-white/90">{t("tracks")}</h2>
                {tracks.length === 0 ? (
                    <p className="px-5 text-sm text-white/50">{t("empty")}</p>
                ) : (
                    tracks.map((tr, i) => (
                        <TrackRow
                            key={tr.id}
                            track={tr}
                            queue={tracks}
                            index={i}
                            onLike={toggleLike}
                            onAddToPlaylist={setPlaylistTarget}
                        />
                    ))
                )}
            </section>

            <LockedOverlay />
            <AddToPlaylistSheet track={playlistTarget} onClose={() => setPlaylistTarget(null)} />
        </main>
    );
}
