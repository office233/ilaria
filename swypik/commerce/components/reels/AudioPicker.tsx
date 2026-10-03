"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import { Search, X, Play, Pause, Check, Music } from "lucide-react";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/ui/EmptyState";

export interface AudioTrackDTO {
  id: number;
  source: string;
  sourceId: string;
  title: string;
  artist: string;
  durationS: number;
  audioUrl: string;
  imageUrl: string | null;
  tags: string[];
  genre: string | null;
  attributionUrl: string | null;
  popularity: number;
}

interface AudioPickerProps {
  open: boolean;
  onClose: () => void;
  selectedId: number | null;
  onSelect: (track: AudioTrackDTO | null) => void;
}

/** Genurile din filtru (slug-uri din `audio_tracks.genre`; eticheta vine din audioPicker.genres.*). */
const GENRES = ["pop", "rock", "electronic", "hiphop", "jazz", "classical", "ambient", "dance"] as const;
type Genre = (typeof GENRES)[number];

function formatDur(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export default function AudioPicker({ open, onClose, selectedId, onSelect }: AudioPickerProps) {
  const t = useTranslations("audioPicker");
  const [q, setQ] = useState("");
  const [genre, setGenre] = useState<string>("");
  const [tracks, setTracks] = useState<AudioTrackDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const titleId = "audio-picker-title";

  const fetchTracks = useCallback(async (search: string, genreFilter: string) => {
    // Abort any in-flight request before starting a new one
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      if (genreFilter) params.set("genre", genreFilter);
      params.set("limit", "50");
      const res = await fetch(`/api/audio/tracks?${params.toString()}`, { signal: controller.signal });
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json();
      if (!controller.signal.aborted) {
        setTracks(Array.isArray(data.tracks) ? data.tracks : []);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(t("loadTracksError"));
      setTracks([]);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [t]);

  // Fetch on open + on filter change (debounced)
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchTracks(q, genre), 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [open, q, genre, fetchTracks]);

  // Stop audio on close
  useEffect(() => {
    if (!open && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      setPlayingId(null);
    }
  }, [open]);

  // A11y: Escape closes, focus search on open, body scroll lock
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // focus the search input
    const t = window.setTimeout(() => searchInputRef.current?.focus(), 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(t);
    };
  }, [open, onClose]);

  const togglePlay = useCallback((track: AudioTrackDTO) => {
    let el = audioRef.current;
    if (!el) {
      el = new Audio();
      el.preload = "none";
      el.onended = () => setPlayingId(null);
      audioRef.current = el;
    }
    if (playingId === track.id) {
      el.pause();
      setPlayingId(null);
    } else {
      el.src = track.audioUrl;
      el.currentTime = 0;
      el.play().then(() => setPlayingId(track.id)).catch(() => setPlayingId(null));
    }
  }, [playingId]);

  const handleSelect = useCallback((track: AudioTrackDTO) => {
    if (audioRef.current) {
      audioRef.current.pause();
      setPlayingId(null);
    }
    onSelect(track);
    onClose();
  }, [onSelect, onClose]);

  const handleClear = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      setPlayingId(null);
    }
    onSelect(null);
    onClose();
  }, [onSelect, onClose]);

  if (!open) return null;

  const filtered = q.trim() !== "" || genre !== "";
  const genreLabel = (g: string | null) =>
    g && (GENRES as readonly string[]).includes(g) ? t(`genres.${g as Genre}`) : g;

  return (
    <div
      className="fixed inset-0 z-overlay flex items-end justify-center bg-overlay/80 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-theme="dark"
        className="flex max-h-[85vh] w-full flex-col rounded-t-sheet border border-subtle bg-elevated pb-safe-b text-fg sm:max-w-md sm:rounded-sheet sm:pb-0"
      >
        {/* Header */}
        <div className="flex h-14 items-center justify-between border-b border-subtle px-4">
          <button
            onClick={onClose}
            aria-label={t("inchide")}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 active:scale-95"
          >
            <X size={18} />
          </button>
          <h2 id={titleId} className="text-sm font-bold">{t("choosePiece")}</h2>
          <button onClick={handleClear} className="text-xs font-bold text-fg-muted hover:text-fg">
            {selectedId ? t("remove") : t("none")}
          </button>
        </div>

        {/* Search */}
        <div className="px-4 pt-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <input
              ref={searchInputRef}
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("cautaTitluArtistTag")}
              aria-label={t("cautaPiesa")}
              className="w-full rounded-full border border-subtle bg-surface-2 py-2.5 pl-9 pr-3 text-sm focus:border-strong focus:outline-none"
            />
          </div>
        </div>

        {/* Genre chips */}
        <div className="overflow-x-auto px-4 pb-2 pt-3">
          <div className="flex min-w-max gap-2">
            <button
              onClick={() => setGenre("")}
              className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                genre === "" ? "bg-fg text-canvas" : "bg-surface-2 text-fg-muted"
              }`}
            >
              {t("allGenres")}
            </button>
            {GENRES.map((g) => (
              <button
                key={g}
                onClick={() => setGenre(genre === g ? "" : g)}
                className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                  genre === g ? "bg-fg text-canvas" : "bg-surface-2 text-fg-muted"
                }`}
              >
                {t(`genres.${g}`)}
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {loading && <div className="py-8 text-center text-xs text-fg-subtle">{t("seIncarca")}</div>}
          {error && <div className="py-8 text-center text-xs text-danger">{error}</div>}
          {!loading && !error && tracks.length === 0 && (
            filtered ? (
              <div className="py-8 text-center text-xs text-fg-subtle">{t("nicioPiesaGasita")}</div>
            ) : (
              // Biblioteca e goală (nicio piesă licențiată comercial): spunem adevărul,
              // clipul se publică cu sunetul lui original.
              <EmptyState icon={Music} title={t("emptyLibraryTitle")} description={t("emptyLibraryHint")} />
            )
          )}
          {tracks.map((track) => {
            const isPlaying = playingId === track.id;
            const isSelected = selectedId === track.id;
            return (
              <div
                key={track.id}
                className={`my-0.5 flex items-center gap-3 rounded-control p-2 ${
                  isSelected ? "bg-surface-2" : "hover:bg-surface-2/60"
                }`}
              >
                <button
                  onClick={() => togglePlay(track)}
                  aria-label={isPlaying ? t("pause") : t("play")}
                  className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-control bg-surface-2 active:scale-95"
                >
                  {track.imageUrl ? (
                    <Image src={track.imageUrl} alt="" width={48} height={48} className="h-full w-full object-cover" unoptimized />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <Music size={18} className="text-fg-subtle" />
                    </div>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-overlay/40 text-fg">
                    {isPlaying ? <Pause size={16} className="fill-current" /> : <Play size={16} className="fill-current" />}
                  </div>
                </button>
                <button onClick={() => handleSelect(track)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-bold">{track.title}</div>
                  <div className="truncate text-xs text-fg-muted">
                    {track.artist} · {formatDur(track.durationS)}
                    {track.genre ? ` · ${genreLabel(track.genre)}` : ""}
                  </div>
                </button>
                {isSelected && (
                  <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-fg text-canvas">
                    <Check size={14} strokeWidth={3} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
