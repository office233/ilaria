"use client";

/**
 * Motorul de redare: coadă, pornire piesă (flux direct cu alternative sau URL Swypik cu token),
 * avans/repeat/shuffle și evenimentele elementului `<audio>`.
 *
 * Gestul userului (iOS Safari): `play()` e apelat sincron din handler-ul de click — `playAt`
 * nu are niciun `await` înainte de `audio.play()` pe ramura de flux; pe ramura Swypik (URL
 * obținut prin fetch) elementul e „deblocat" sincron cu un clip mut înainte de `await`.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { MUSIC_PLAY_COUNT_AFTER_S } from "@/lib/music/config";
import { buildShuffleOrder, lockedAfterAdvance, nextTrackIndex, type AdvanceReason, type RepeatMode } from "@/lib/music/player-rules";
import { STREAM_START_TIMEOUT_MS } from "@/lib/music/player/config";
import { isSilentPrimerSrc, silentWavDataUri } from "@/lib/music/player/silent-audio";
import { createStreamFallback, type StreamFallbackController } from "@/lib/music/player/stream-fallback";
import { streamCandidates } from "@/lib/music/player/stream-hosts";
import type { TrackDto } from "@/lib/music/types";
import { countPlay, isLockedResult, requestPlayUrl } from "./api";
import type { MusicLockedInfo } from "./context";

function isAutoplayBlocked(err: unknown): boolean {
    return err instanceof DOMException && err.name === "NotAllowedError";
}

export function usePlaybackEngine(audioRef: RefObject<HTMLAudioElement | null>) {
    const [queue, setQueue] = useState<TrackDto[]>([]);
    const [index, setIndex] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [positionMs, setPositionMs] = useState(0);
    const [durationMs, setDurationMs] = useState(0);
    const [locked, setLocked] = useState<MusicLockedInfo | null>(null);
    const [shuffle, setShuffle] = useState(false);
    const [repeat, setRepeat] = useState<RepeatMode>("off");
    const [streamError, setStreamError] = useState(false);

    const queueRef = useRef<TrackDto[]>(queue);
    const indexRef = useRef(index);
    const genRef = useRef(0);
    const hasSourceRef = useRef(false);
    const playedCountedRef = useRef(false);
    const erroredOnceRef = useRef(false);
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const streamRef = useRef<StreamFallbackController | null>(null);
    const shuffleRef = useRef(shuffle);
    const repeatRef = useRef(repeat);
    const shuffleOrderRef = useRef<number[]>([]);

    useEffect(() => { queueRef.current = queue; }, [queue]);
    useEffect(() => { indexRef.current = index; }, [index]);
    useEffect(() => { shuffleRef.current = shuffle; }, [shuffle]);
    useEffect(() => { repeatRef.current = repeat; }, [repeat]);
    useEffect(() => { shuffleOrderRef.current = buildShuffleOrder(queue.length); }, [queue, shuffle]);

    function clearRefreshTimer(): void {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
    }

    function disposeStream(): void {
        streamRef.current?.dispose();
        streamRef.current = null;
    }

    /** Setează sursa și pornește redarea; eșecul `play()` (autoplay blocat) lasă player-ul pe pauză. */
    function setSourceAndPlay(audio: HTMLAudioElement, url: string): Promise<void> {
        audio.src = url;
        hasSourceRef.current = true;
        return audio.play();
    }

    /** Calculează piesa care urmează (secvențial sau shuffle, respectând repeat) și pornește redarea. */
    function advance(reason: AdvanceReason, direction: "forward" | "backward" = "forward"): void {
        const list = queueRef.current;
        const idx = nextTrackIndex({
            queueLength: list.length,
            currentIndex: indexRef.current,
            direction,
            naturalEnd: reason === "ended",
            shuffle: shuffleRef.current,
            repeat: repeatRef.current,
            shuffleOrder: shuffleOrderRef.current,
        });
        const gen = ++genRef.current;
        if (idx !== null) void playAt(list, idx, gen, reason);
        else if (direction === "backward") void playAt(list, -1, gen); // fără piesă anterioară → reia de la 0
        else void playAt(list, list.length, gen, reason); // fără piesă următoare → oprește
    }

    /** Reîmprospătează URL-ul cu token înainte să expire, dacă piesa încă redă. */
    function scheduleRefresh(track: TrackDto, expiresAt: number | null, list: TrackDto[], i: number, gen: number): void {
        clearRefreshTimer();
        if (!expiresAt) return;
        const delay = Math.max(2_000, expiresAt - Date.now() - 10_000);
        refreshTimerRef.current = setTimeout(() => {
            if (gen !== genRef.current) return;
            const audio = audioRef.current;
            if (!audio || audio.paused) return;
            void loadNativeUrl(track, list, i, gen, { resumeAt: audio.currentTime });
        }, delay);
    }

    /**
     * Obține URL-ul Swypik (cu token) și îl redă. `resumeAt` = reîmprospătare pe loc a unei piese
     * care deja rulează. 402 → paywall + sare mai departe; eșec → piesa următoare.
     */
    async function loadNativeUrl(track: TrackDto, list: TrackDto[], i: number, gen: number, opts: { resumeAt?: number } = {}): Promise<void> {
        const result = await requestPlayUrl(track);
        if (gen !== genRef.current) return;
        if (!result || isLockedResult(result)) {
            // Paywall doar la pornirea piesei; la reîmprospătare/eroare doar trecem mai departe.
            const lockedInfo = result && opts.resumeAt === undefined ? result.locked : null;
            if (lockedInfo) setLocked(lockedInfo);
            void playAt(list, i + 1, ++genRef.current, lockedInfo ? "locked" : "error");
            return;
        }
        const audio = audioRef.current;
        if (!audio) return;
        const wasPlaying = !audio.paused;
        audio.src = result.url;
        hasSourceRef.current = true;
        if (opts.resumeAt !== undefined) audio.currentTime = opts.resumeAt;
        scheduleRefresh(track, result.expiresAt, list, i, gen);
        if (opts.resumeAt === undefined || wasPlaying) void audio.play().catch(() => {});
    }

    /** Flux direct (radio/Audius/Jamendo/podcast) cu alternative și timeout de pornire. */
    function startStream(audio: HTMLAudioElement, track: TrackDto, list: TrackDto[], i: number, gen: number): void {
        disposeStream();
        const controller = createStreamFallback(streamCandidates(track), STREAM_START_TIMEOUT_MS, {
            onTry: (url) => {
                setSourceAndPlay(audio, url).catch((err: unknown) => {
                    if (gen === genRef.current && isAutoplayBlocked(err)) controller.handle({ type: "idle" });
                });
            },
            onStarted: () => setStreamError(false),
            onFail: () => {
                if (gen !== genRef.current) return;
                audio.pause();
                setPlaying(false);
                if (!track.isLive && i + 1 < list.length) {
                    void playAt(list, i + 1, ++genRef.current, "error");
                    return;
                }
                setStreamError(true);
            },
        });
        streamRef.current = controller;
        controller.start();
    }

    async function playAt(list: TrackDto[], i: number, gen: number, reason: AdvanceReason = "user"): Promise<void> {
        if (gen !== genRef.current) return;
        if (i < 0) {
            // „prev" înainte de prima piesă
            const audio = audioRef.current;
            if (audio && list.length > 0) {
                audio.currentTime = 0;
                setPositionMs(0);
            }
            return;
        }
        disposeStream();
        clearRefreshTimer();
        if (i >= list.length) {
            setQueue(list);
            setPlaying(false);
            return;
        }

        const track = list[i];
        setQueue(list);
        setIndex(i);
        setLocked((prev) => lockedAfterAdvance(prev, reason));
        setStreamError(false);
        setPositionMs(0);
        setDurationMs(track.durationMs);
        playedCountedRef.current = false;
        erroredOnceRef.current = false;

        const audio = audioRef.current;
        if (!audio) return;
        if (track.streamUrl) {
            startStream(audio, track, list, i, gen); // play() sincron, în gestul userului
            return;
        }
        if (reason === "user") {
            // Deblocare iOS: redăm sincron un clip mut; URL-ul real vine după fetch.
            audio.src = silentWavDataUri();
            hasSourceRef.current = false;
            void audio.play().catch(() => {});
        }
        await loadNativeUrl(track, list, i, gen);
    }

    function currentTrack(): TrackDto | undefined {
        return queueRef.current[indexRef.current];
    }

    function countIfNeeded(force: boolean): void {
        const audio = audioRef.current;
        if (playedCountedRef.current || !audio) return;
        if (!force && audio.currentTime < MUSIC_PLAY_COUNT_AFTER_S) return;
        playedCountedRef.current = true;
        const track = currentTrack();
        if (track) countPlay(track.id);
    }

    function handleNativeError(track: TrackDto): void {
        if (erroredOnceRef.current) {
            void playAt(queueRef.current, indexRef.current + 1, ++genRef.current, "error");
            return;
        }
        erroredOnceRef.current = true;
        void loadNativeUrl(track, queueRef.current, indexRef.current, genRef.current);
    }

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;
        const priming = () => isSilentPrimerSrc(audio.getAttribute("src"));
        const on: Record<string, () => void> = {
            timeupdate: () => { setPositionMs(audio.currentTime * 1000); countIfNeeded(false); },
            loadedmetadata: () => { if (Number.isFinite(audio.duration) && audio.duration > 0) setDurationMs(audio.duration * 1000); },
            ended: () => { countIfNeeded(true); advance("ended", "forward"); },
            error: () => {
                const track = currentTrack();
                if (!track) return;
                if (streamRef.current) streamRef.current.handle({ type: "error" });
                else if (!track.streamUrl) handleNativeError(track);
            },
            stalled: () => streamRef.current?.handle({ type: "stalled" }),
            play: () => { setPlaying(true); streamRef.current?.handle({ type: "play" }); },
            playing: () => { setPlaying(true); streamRef.current?.handle({ type: "playing" }); },
            pause: () => { setPlaying(false); streamRef.current?.handle({ type: "idle" }); },
        };
        const listeners = Object.entries(on).map(([type, fn]) => {
            const listener = () => { if (!priming()) fn(); };
            audio.addEventListener(type, listener);
            return [type, listener] as const;
        });
        return () => {
            for (const [type, listener] of listeners) audio.removeEventListener(type, listener);
            disposeStream();
            clearRefreshTimer();
        };
        // Handler-ele citesc starea prin ref-uri; se leagă o singură dată la montare.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return {
        state: { queue, index, playing, positionMs, durationMs, locked, shuffle, repeat, streamError },
        refs: { queueRef, indexRef, genRef, hasSourceRef },
        playAt,
        advance,
        setPositionMs,
        setLocked,
        setShuffle,
        setRepeat,
        reset: () => {
            genRef.current++;
            disposeStream();
            clearRefreshTimer();
            hasSourceRef.current = false;
            setQueue([]);
            setIndex(0);
            setPlaying(false);
            setPositionMs(0);
            setDurationMs(0);
            setLocked(null);
            setStreamError(false);
        },
    };
}
