"use client";

/**
 * Bottom-sheet „adaugă la playlist": listă playlist-uri proprii (fără lista
 * „Îmi plac" — aceea are propriul buton inimă) + un câmp pentru playlist nou.
 * Nu există încă în components/music/, deci trăiește local, folosit din toate
 * paginile publice Music care afișează TrackRow.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { Check, ListPlus, Loader2, Plus, X } from "lucide-react";
import { haptic } from "@/lib/haptic";
import type { TrackDto } from "@/lib/music/types";

type PlaylistSummary = { id: string; title: string; track_count: number; is_liked_list: boolean };

type Props = {
    track: TrackDto | null;
    onClose: () => void;
};

export default function AddToPlaylistSheet({ track, onClose }: Props) {
    const t = useTranslations("music");
    const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
    const [addedId, setAddedId] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [newTitle, setNewTitle] = useState("");

    useEffect(() => {
        if (!track) return;
        setPlaylists(null);
        setAddedId(null);
        setNewTitle("");
        setCreating(false);
        fetch("/api/music/playlists", { cache: "no-store" })
            .then((res) => (res.ok ? res.json() : { playlists: [] }))
            .then((data: { playlists?: PlaylistSummary[] }) => setPlaylists((data.playlists ?? []).filter((p) => !p.is_liked_list)))
            .catch(() => setPlaylists([]));
    }, [track]);

    if (!track || typeof document === "undefined") return null;

    const addTo = async (playlistId: string) => {
        haptic("tap");
        setBusyId(playlistId);
        try {
            const res = await fetch(`/api/music/playlists/${playlistId}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ trackId: track.id }),
            });
            if (res.ok) setAddedId(playlistId);
        } finally {
            setBusyId(null);
        }
    };

    const createAndAdd = async () => {
        const title = newTitle.trim();
        if (!title || busyId === "new") return;
        haptic("tap");
        setBusyId("new");
        try {
            const res = await fetch("/api/music/playlists", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title }),
            });
            if (!res.ok) return;
            const data = (await res.json()) as { playlist: { id: string; title: string } };
            await addTo(data.playlist.id);
            setPlaylists((prev) => [...(prev ?? []), { id: data.playlist.id, title: data.playlist.title, track_count: 1, is_liked_list: false }]);
            setCreating(false);
            setNewTitle("");
        } finally {
            setBusyId(null);
        }
    };

    return createPortal(
        <div className="fixed inset-0 z-[105] flex flex-col justify-end">
            <button type="button" className="absolute inset-0 bg-black/60" onClick={onClose} aria-label={t("close")} />
            <section
                role="dialog"
                aria-modal="true"
                className="relative max-h-[75vh] overflow-y-auto rounded-t-3xl bg-[#121218] px-5 pt-4 text-white shadow-2xl"
                style={{ paddingBottom: "max(24px, env(safe-area-inset-bottom))" }}
            >
                <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-base font-black">{t("addToPlaylist")}</h2>
                    <button type="button" onClick={onClose} aria-label={t("close")} className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-white/70">
                        <X size={18} />
                    </button>
                </div>

                {playlists === null ? (
                    <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-white/50" /></div>
                ) : (
                    <ul className="space-y-1.5">
                        {playlists.map((p) => (
                            <li key={p.id}>
                                <button
                                    type="button"
                                    onClick={() => addTo(p.id)}
                                    disabled={busyId === p.id}
                                    className="flex w-full items-center justify-between rounded-xl bg-white/5 px-4 py-3 text-left text-sm font-bold text-white ring-1 ring-white/10 active:scale-[0.99] disabled:opacity-60"
                                >
                                    <span className="truncate">{p.title}</span>
                                    {busyId === p.id ? (
                                        <Loader2 size={16} className="animate-spin text-white/60" />
                                    ) : addedId === p.id ? (
                                        <Check size={16} className="text-[#7C3AED]" />
                                    ) : (
                                        <ListPlus size={16} className="text-white/50" />
                                    )}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}

                {creating ? (
                    <div className="mt-3 flex gap-2">
                        <input
                            autoFocus
                            value={newTitle}
                            onChange={(e) => setNewTitle(e.target.value)}
                            placeholder={t("playlistName")}
                            maxLength={80}
                            className="min-w-0 flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-bold text-white outline-none focus:border-[#7C3AED]"
                        />
                        <button
                            type="button"
                            onClick={createAndAdd}
                            disabled={!newTitle.trim() || busyId === "new"}
                            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white text-black disabled:opacity-50"
                            aria-label={t("save")}
                        >
                            {busyId === "new" ? <Loader2 size={16} className="animate-spin" /> : <Check size={18} />}
                        </button>
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={() => { haptic("tap"); setCreating(true); }}
                        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-white/20 px-4 py-3 text-sm font-bold text-white/70"
                    >
                        <Plus size={16} /> {t("newPlaylist")}
                    </button>
                )}
            </section>
        </div>,
        document.body,
    );
}
