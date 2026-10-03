"use client";

/**
 * Pagina unui playlist propriu: titlu, Play all, listă de piese cu opțiunea
 * de a le scoate din listă. `TrackRow` (components/music/) nu are un buton de
 * eliminare — se adaugă local, lângă rând, ca să nu se atingă componenta
 * partajată.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "@/lib/i18n/navigation";
import { ArrowLeft, Play, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import TrackRow from "@/components/music/TrackRow";
import { useMusicPlayer } from "@/components/music/MusicPlayerProvider";
import { moviesDisplayFont, MOVIES_DISPLAY_CLASS } from "@/components/movies/fonts";
import { haptic } from "@/lib/haptic";
import type { TrackDto } from "@/lib/music/types";
import AddToPlaylistSheet from "../../_components/AddToPlaylistSheet";
import LockedOverlay from "../../_components/LockedOverlay";
import { setTrackLiked } from "../../_lib/track-actions";

type PlaylistRow = { id: string; title: string; is_liked_list: boolean };
type Payload = { playlist: PlaylistRow; tracks: TrackDto[] };

export default function PlaylistClient({ id }: { id: string }) {
    const t = useTranslations("music");
    const router = useRouter();
    const { play } = useMusicPlayer();
    const [data, setData] = useState<Payload | null>(null);
    const [notFoundState, setNotFoundState] = useState(false);
    const [error, setError] = useState(false);
    const [playlistTarget, setPlaylistTarget] = useState<TrackDto | null>(null);

    const load = useCallback(() => {
        fetch(`/api/music/playlists/${id}`, { cache: "no-store" })
            .then((r) => {
                if (r.status === 401) { router.push(`/auth?next=/music/playlist/${id}`); return null; }
                if (r.status === 404) { setNotFoundState(true); return null; }
                if (!r.ok) return Promise.reject(r.status);
                return r.json();
            })
            .then((d: Payload | null) => { if (d) setData(d); })
            .catch(() => setError(true));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);
    useEffect(load, [load]);

    const toggleLike = async (track: TrackDto) => {
        if (!data) return;
        const next = !track.liked;
        setData({ ...data, tracks: data.tracks.map((tr) => (tr.id === track.id ? { ...tr, liked: next } : tr)) });
        const ok = await setTrackLiked(track.slug, next);
        if (!ok) setData((prev) => (prev ? { ...prev, tracks: prev.tracks.map((tr) => (tr.id === track.id ? { ...tr, liked: track.liked } : tr)) } : prev));
    };

    const removeTrack = async (track: TrackDto) => {
        if (!data) return;
        haptic("tap");
        const prevTracks = data.tracks;
        setData({ ...data, tracks: data.tracks.filter((tr) => tr.id !== track.id) });
        try {
            const res = await fetch(`/api/music/playlists/${id}/items`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ trackId: track.id }),
            });
            if (!res.ok) setData((prev) => (prev ? { ...prev, tracks: prevTracks } : prev));
        } catch {
            setData((prev) => (prev ? { ...prev, tracks: prevTracks } : prev));
        }
    };

    if (error) return <div className="flex min-h-screen items-center justify-center bg-[#0B0B12] text-white/70">{t("loadError")}</div>;
    if (notFoundState) return <div className="flex min-h-screen items-center justify-center bg-[#0B0B12] text-white/70">{t("empty")}</div>;
    if (!data) return <div className="min-h-screen bg-[#0B0B12]" />;

    const { playlist, tracks } = data;

    return (
        <main className={`${moviesDisplayFont.variable} min-h-screen bg-[#0B0B12] pb-24 text-white`}>
            <header className="fixed inset-x-0 top-0 z-30 flex items-center gap-3 bg-gradient-to-b from-black/90 to-transparent px-4 pb-3" style={{ paddingTop: "max(10px, env(safe-area-inset-top))" }}>
                <Link href="/music" aria-label={t("back")} className="rounded-full bg-black/40 p-2 ring-1 ring-white/15"><ArrowLeft size={18} /></Link>
            </header>

            <section className="px-5 pt-20">
                <h1 className={`${MOVIES_DISPLAY_CLASS} truncate text-4xl leading-[0.95] text-white`}>{playlist.title}</h1>
                <button
                    type="button"
                    onClick={() => { haptic("tap"); if (tracks.length > 0) play(tracks, 0); }}
                    disabled={tracks.length === 0}
                    className="mt-4 flex items-center gap-2 rounded-full bg-white px-6 py-2.5 text-sm font-black text-black active:scale-95 disabled:opacity-40"
                >
                    <Play size={18} fill="currentColor" /> {t("playAll")}
                </button>
            </section>

            <section className="mt-8">
                {tracks.length === 0 ? (
                    <p className="px-5 text-sm text-white/50">{t("empty")}</p>
                ) : (
                    tracks.map((tr, i) => (
                        <div key={tr.id} className="flex items-center">
                            <div className="min-w-0 flex-1">
                                <TrackRow track={tr} queue={tracks} index={i} onLike={toggleLike} onAddToPlaylist={setPlaylistTarget} />
                            </div>
                            <button
                                type="button"
                                onClick={() => removeTrack(tr)}
                                aria-label={t("removeFromPlaylist")}
                                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/50 active:scale-95"
                            >
                                <Trash2 size={16} />
                            </button>
                        </div>
                    ))
                )}
            </section>

            <LockedOverlay />
            <AddToPlaylistSheet track={playlistTarget} onClose={() => setPlaylistTarget(null)} />
        </main>
    );
}
