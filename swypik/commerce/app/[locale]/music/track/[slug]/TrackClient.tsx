"use client";

/**
 * Pagina unei piese: copertă mare, titlu, artist, Play/Like/+Playlist/Susține/
 * Folosește în reel, paywall inline dacă `track.locked`, și — dacă piesa face
 * parte dintr-un album — lista completă a albumului (cerută separat, DTO-ul de
 * la `/api/music/tracks/<slug>` nu include piesele albumului).
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Heart, ListPlus, Music2, Pause, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import TrackRow from "@/components/music/TrackRow";
import MusicPaywall from "@/components/music/MusicPaywall";
import { useMusicPlayer, type MusicLockedInfo } from "@/components/music/MusicPlayerProvider";
import { formatDuration } from "@/components/music/format";
import { moviesDisplayFont, MOVIES_DISPLAY_CLASS } from "@/components/movies/fonts";
import { haptic } from "@/lib/haptic";
import type { AlbumDto, TrackDto } from "@/lib/music/types";
import AddToPlaylistSheet from "../../_components/AddToPlaylistSheet";
import { setTrackLiked } from "../../_lib/track-actions";

type Payload = { track: TrackDto; album: AlbumDto | null; viewer: { requireAuth: boolean } };

export default function TrackClient({ slug }: { slug: string }) {
    const t = useTranslations("music");
    const { current, playing, play, toggle } = useMusicPlayer();
    const [data, setData] = useState<Payload | null>(null);
    const [albumTracks, setAlbumTracks] = useState<TrackDto[] | null>(null);
    const [notFoundState, setNotFoundState] = useState(false);
    const [error, setError] = useState(false);
    const [playlistOpen, setPlaylistOpen] = useState(false);

    const load = useCallback(() => {
        fetch(`/api/music/tracks/${slug}`, { cache: "no-store" })
            .then((r) => {
                if (r.status === 404) { setNotFoundState(true); return null; }
                if (!r.ok) return Promise.reject(r.status);
                return r.json();
            })
            .then((d: Payload | null) => { if (d) setData(d); })
            .catch(() => setError(true));
    }, [slug]);
    useEffect(load, [load]);

    useEffect(() => {
        if (!data?.album) { setAlbumTracks(null); return; }
        fetch(`/api/music/albums/${data.album.slug}`, { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then((d: { tracks: TrackDto[] } | null) => setAlbumTracks(d?.tracks ?? null))
            .catch(() => setAlbumTracks(null));
    }, [data?.album]);

    if (error) return <div className="flex min-h-screen items-center justify-center bg-[#0B0B12] text-white/70">{t("loadError")}</div>;
    if (notFoundState) return <div className="flex min-h-screen items-center justify-center bg-[#0B0B12] text-white/70">{t("empty")}</div>;
    if (!data) return <div className="min-h-screen bg-[#0B0B12]" />;

    const { track, album, viewer } = data;
    const isCurrent = current?.id === track.id;

    const toggleLike = async () => {
        const next = !track.liked;
        setData({ ...data, track: { ...track, liked: next } });
        const ok = await setTrackLiked(track.slug, next);
        if (!ok) setData((prev) => (prev ? { ...prev, track: { ...prev.track, liked: track.liked } } : prev));
    };

    const lockedInfo: MusicLockedInfo | null = track.locked
        ? { track, priceCents: track.priceCents, albumPriceCents: album?.priceCents ?? null, requireAuth: viewer.requireAuth }
        : null;

    const handleUnlocked = () => {
        load();
        play([track], 0);
    };

    return (
        <main className={`${moviesDisplayFont.variable} min-h-screen bg-[#0B0B12] pb-24 text-white`}>
            <header className="fixed inset-x-0 top-0 z-30 flex items-center gap-3 bg-gradient-to-b from-black/90 to-transparent px-4 pb-3" style={{ paddingTop: "max(10px, env(safe-area-inset-top))" }}>
                <Link href="/music" aria-label={t("back")} className="rounded-full bg-black/40 p-2 ring-1 ring-white/15"><ArrowLeft size={18} /></Link>
            </header>

            <section className="px-5 pt-20">
                <div className="mx-auto aspect-square w-full max-w-xs overflow-hidden rounded-2xl bg-white/10 shadow-2xl ring-1 ring-white/10">
                    {track.coverUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={track.coverUrl} alt={track.title} className="h-full w-full object-cover" />
                    ) : (
                        <div className="h-full w-full bg-gradient-to-b from-white/10 to-black" />
                    )}
                </div>

                <div className="mx-auto mt-5 max-w-xs text-center">
                    <h1 className={`${MOVIES_DISPLAY_CLASS} truncate text-4xl leading-[0.95] text-white`}>{track.title}</h1>
                    <Link href={`/music/artist/${track.artist.slug}`} className="mt-1 block truncate text-sm text-white/70">{track.artist.stageName}</Link>

                    <div className="mt-2 flex items-center justify-center gap-2 text-xs text-white/50">
                        <span className="tabular-nums">{formatDuration(track.durationMs)}</span>
                        {track.isPremium ? (
                            <span className="rounded bg-[#7C3AED]/20 px-1.5 py-0.5 font-black uppercase tracking-wide text-[#A78BFA]">{t("premium")}</span>
                        ) : (
                            <span className="rounded bg-white/10 px-1.5 py-0.5 font-black uppercase tracking-wide text-white/60">{t("free")}</span>
                        )}
                        {track.explicit && <span className="rounded bg-white/10 px-1.5 py-0.5 font-black uppercase tracking-wide text-white/60">{t("explicitBadge")}</span>}
                    </div>
                </div>

                {lockedInfo ? (
                    <div className="mx-auto mt-5 max-w-xs">
                        <MusicPaywall locked={lockedInfo} albumSlug={album?.slug} onClose={() => {}} onUnlocked={handleUnlocked} />
                    </div>
                ) : (
                    <div className="mx-auto mt-5 flex max-w-xs justify-center">
                        <button
                            type="button"
                            onClick={() => { haptic("tap"); if (isCurrent) toggle(); else play([track], 0); }}
                            aria-label={isCurrent && playing ? t("pause") : t("play")}
                            className="grid h-16 w-16 place-items-center rounded-full bg-white text-black active:scale-95"
                        >
                            {isCurrent && playing ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
                        </button>
                    </div>
                )}

                <div className="mx-auto mt-4 flex max-w-xs items-center justify-center gap-3">
                    <button
                        type="button"
                        onClick={() => { haptic("tap"); toggleLike(); }}
                        aria-label={track.liked ? t("unlike") : t("like")}
                        aria-pressed={track.liked}
                        className="grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white/80 ring-1 ring-white/15 active:scale-95"
                    >
                        <Heart size={18} className={track.liked ? "fill-[#7C3AED] text-[#7C3AED]" : ""} />
                    </button>
                    <button
                        type="button"
                        onClick={() => { haptic("tap"); setPlaylistOpen(true); }}
                        aria-label={t("addToPlaylist")}
                        className="grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white/80 ring-1 ring-white/15 active:scale-95"
                    >
                        <ListPlus size={18} />
                    </button>
                    {track.audioTrackId !== null && (
                        <Link
                            href={`/upload?audio=${track.audioTrackId}`}
                            aria-label={t("useInReel")}
                            className="grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white/80 ring-1 ring-white/15 active:scale-95"
                        >
                            <Music2 size={18} />
                        </Link>
                    )}
                </div>
            </section>

            {album && (
                <section className="mt-8">
                    <Link href={`/music/album/${album.slug}`} className="mx-5 mb-3 flex items-center gap-3 rounded-xl bg-white/5 p-3 ring-1 ring-white/10 active:scale-[0.99]">
                        <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-white/10">
                            {album.coverUrl && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={album.coverUrl} alt={album.title} className="h-full w-full object-cover" />
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="text-[11px] uppercase tracking-wide text-white/40">{t("album")}</p>
                            <p className="truncate text-sm font-bold text-white">{album.title}</p>
                        </div>
                    </Link>
                    {albumTracks && albumTracks.map((tr, i) => (
                        <TrackRow key={tr.id} track={tr} queue={albumTracks} index={i} />
                    ))}
                </section>
            )}

            <AddToPlaylistSheet track={playlistOpen ? track : null} onClose={() => setPlaylistOpen(false)} />
        </main>
    );
}
