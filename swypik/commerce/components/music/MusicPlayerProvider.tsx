"use client";

/**
 * Player-ul audio persistent al Swypik Music: audio nativ Swypik (R2, <audio> ascuns)
 * + surse legale audio-only (radio live, Audius, Jamendo, podcast).
 * Montat o singură dată în `components/layout/AppShell.tsx` (layout-ul `[locale]`), deci
 * `<audio>` și starea supraviețuiesc navigării client-side între pagini.
 *
 * Logica e împărțită în `./player/*`: motorul de redare, volumul, MediaSession, preconnect.
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { isEnabledClient } from "@/lib/feature-flags-client";
import { DISABLED_CONTEXT, MusicPlayerContext, type MusicPlayerContextValue } from "./player/context";
import { preconnectTrack } from "./player/preconnect";
import { useMediaSession, type MediaSessionControls } from "./player/useMediaSession";
import { usePlaybackEngine } from "./player/usePlaybackEngine";
import { useVolume } from "./player/useVolume";
import type { TrackDto } from "@/lib/music/types";

export { useMusicPlayer, type MusicLockedInfo, type MusicPlayerContextValue } from "./player/context";

function ActiveMusicPlayerProvider({ children }: { children: ReactNode }) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const engine = usePlaybackEngine(audioRef);
    const { queue, index, playing, positionMs, durationMs, locked, shuffle, repeat, streamError } = engine.state;
    const { volume, muted, setVolume, setMuted, reapply } = useVolume(audioRef);
    const current = queue[index] ?? null;

    // Funcțiile motorului se recreează la fiecare randare; le citim prin ref ca să păstrăm callback-uri stabile.
    const engineRef = useRef(engine);
    engineRef.current = engine;
    const streamErrorRef = useRef(streamError);
    streamErrorRef.current = streamError;

    /** Sincron în handler-ul de click: `playAt` apelează `audio.play()` înainte de orice `await`. */
    const play = useCallback((tracks: TrackDto[], startIndex = 0) => {
        const e = engineRef.current;
        void e.playAt(tracks, startIndex, ++e.refs.genRef.current);
    }, []);

    /** Fluxul a eșuat complet → un nou tap reîncearcă de la primul URL (tot în gestul userului). */
    const retryCurrent = useCallback((): boolean => {
        if (!streamErrorRef.current) return false;
        const e = engineRef.current;
        void e.playAt(e.refs.queueRef.current, e.refs.indexRef.current, ++e.refs.genRef.current);
        return true;
    }, []);

    const resume = useCallback(() => {
        const audio = audioRef.current;
        if (retryCurrent() || !audio || !engineRef.current.refs.hasSourceRef.current) return;
        void audio.play().catch(() => {});
    }, [retryCurrent]);

    const pause = useCallback(() => { audioRef.current?.pause(); }, []);

    const toggle = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused || streamErrorRef.current) resume();
        else audio.pause();
    }, [resume]);

    const next = useCallback(() => engineRef.current.advance("user", "forward"), []);
    const prev = useCallback(() => engineRef.current.advance("user", "backward"), []);

    const seek = useCallback((ms: number) => {
        const { queueRef, indexRef, hasSourceRef } = engineRef.current.refs;
        if (queueRef.current[indexRef.current]?.isLive) return; // Fluxurile radio live nu au seek
        const audio = audioRef.current;
        if (!audio || !hasSourceRef.current) return;
        const seconds = Math.max(0, ms / 1000);
        audio.currentTime = Number.isFinite(audio.duration) ? Math.min(audio.duration, seconds) : seconds;
        engineRef.current.setPositionMs(ms);
    }, []);

    const close = useCallback(() => {
        engineRef.current.reset();
        const audio = audioRef.current;
        if (audio) {
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
        }
    }, []);

    const dismissLocked = useCallback(() => engineRef.current.setLocked(null), []);
    const toggleShuffle = useCallback(() => engineRef.current.setShuffle((prevValue) => !prevValue), []);
    const cycleRepeat = useCallback(() => {
        engineRef.current.setRepeat((prevValue) => (prevValue === "off" ? "all" : prevValue === "all" ? "one" : "off"));
    }, []);

    // Volumul curent se reaplică la fiecare piesă nouă.
    useEffect(() => { reapply(); }, [current, reapply]);

    // Piesa următoare din coadă: încălzim conexiunea către hostul ei de stream.
    useEffect(() => { preconnectTrack(queue[index + 1]); }, [queue, index]);

    const mediaControls = useMemo<MediaSessionControls>(
        () => ({ resume, pause, stop: close, next, prev, seek }),
        [resume, pause, close, next, prev, seek],
    );
    useMediaSession({ current, playing, positionMs, durationMs, controls: mediaControls });

    const value = useMemo<MusicPlayerContextValue>(() => ({
        current, queue, index, playing, positionMs, durationMs,
        play, toggle, next, prev, seek, close,
        locked, dismissLocked,
        shuffle, toggleShuffle, repeat, cycleRepeat,
        volume, muted, setVolume, setMuted,
        streamError,
    }), [
        current, queue, index, playing, positionMs, durationMs, play, toggle, next, prev, seek, close,
        locked, dismissLocked, shuffle, toggleShuffle, repeat, cycleRepeat, volume, muted, setVolume, setMuted,
        streamError,
    ]);

    return (
        <MusicPlayerContext.Provider value={value}>
            {children}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio ref={audioRef} className="hidden" preload="none" />
        </MusicPlayerContext.Provider>
    );
}

/** Wrapper subțire: dacă flag-ul e OFF randează doar `children` cu context no-op. */
export default function MusicPlayerProvider({ children }: { children: ReactNode }) {
    if (!isEnabledClient("music")) {
        return <MusicPlayerContext.Provider value={DISABLED_CONTEXT}>{children}</MusicPlayerContext.Provider>;
    }
    return <ActiveMusicPlayerProvider>{children}</ActiveMusicPlayerProvider>;
}
