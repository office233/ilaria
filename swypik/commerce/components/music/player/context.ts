"use client";

/** Contractul public al player-ului Swypik Music (context + hook de consum). */
import { createContext, useContext } from "react";
import type { RepeatMode } from "@/lib/music/player-rules";
import type { TrackDto } from "@/lib/music/types";

export type MusicLockedInfo = {
    track: TrackDto;
    /** Preț RON (cenți); `null` = „preț în curând" (creatorul nu l-a setat încă). */
    priceCents: number | null;
    albumPriceCents: number | null;
    requireAuth: boolean;
};

export type MusicPlayerContextValue = {
    current: TrackDto | null;
    queue: TrackDto[];
    index: number;
    playing: boolean;
    positionMs: number;
    durationMs: number;
    play: (tracks: TrackDto[], index?: number) => void;
    toggle: () => void;
    next: () => void;
    prev: () => void;
    seek: (ms: number) => void;
    close: () => void;
    locked: MusicLockedInfo | null;
    dismissLocked: () => void;
    shuffle: boolean;
    toggleShuffle: () => void;
    repeat: RepeatMode;
    cycleRepeat: () => void;
    volume: number;
    muted: boolean;
    setVolume: (value: number) => void;
    setMuted: (value: boolean) => void;
    /** true când toate URL-urile fluxului curent au eșuat (radio/podcast indisponibil). */
    streamError: boolean;
};

function noop(): void {}

/** Context implicit (flag OFF sau afară din provider): totul no-op, coadă goală. */
export const DISABLED_CONTEXT: MusicPlayerContextValue = {
    current: null,
    queue: [],
    index: 0,
    playing: false,
    positionMs: 0,
    durationMs: 0,
    play: noop,
    toggle: noop,
    next: noop,
    prev: noop,
    seek: noop,
    close: noop,
    locked: null,
    dismissLocked: noop,
    shuffle: false,
    toggleShuffle: noop,
    repeat: "off",
    cycleRepeat: noop,
    volume: 1,
    muted: false,
    setVolume: noop,
    setMuted: noop,
    streamError: false,
};

export const MusicPlayerContext = createContext<MusicPlayerContextValue>(DISABLED_CONTEXT);

export function useMusicPlayer(): MusicPlayerContextValue {
    return useContext(MusicPlayerContext);
}
