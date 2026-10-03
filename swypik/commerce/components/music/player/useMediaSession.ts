"use client";

/**
 * Integrarea Media Session API: metadate (titlu, artist, copertă), comenzi din lock screen /
 * căști / ceas și starea de redare. Browserele fără suport sunt ignorate în liniște.
 */
import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { MEDIA_SESSION_SEEK_STEP_MS } from "@/lib/music/player/config";
import { ALL_MEDIA_ACTIONS, buildMediaMetadata, mediaSessionActions, type PlayerMediaAction } from "@/lib/music/player/media-session";
import type { TrackDto } from "@/lib/music/types";

export type MediaSessionControls = {
    resume: () => void;
    pause: () => void;
    stop: () => void;
    next: () => void;
    prev: () => void;
    seek: (ms: number) => void;
};

type Params = {
    current: TrackDto | null;
    playing: boolean;
    positionMs: number;
    durationMs: number;
    controls: MediaSessionControls;
};

function getSession(): MediaSession | null {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return null;
    return navigator.mediaSession;
}

function safeSetHandler(session: MediaSession, action: PlayerMediaAction, handler: MediaSessionActionHandler | null): void {
    try {
        session.setActionHandler(action, handler);
    } catch {
        // acțiune nesuportată de acest browser
    }
}

export function useMediaSession({ current, playing, positionMs, durationMs, controls }: Params): void {
    const t = useTranslations("music");
    const liveAlbum = t("audio.radioLive");
    const defaultAlbum = t("title");
    // Ref: handler-ele înregistrate o dată per piesă citesc mereu ultimele comenzi/poziția.
    const controlsRef = useRef(controls);
    const positionRef = useRef(positionMs);
    useEffect(() => { controlsRef.current = controls; }, [controls]);
    useEffect(() => { positionRef.current = positionMs; }, [positionMs]);

    useEffect(() => {
        const session = getSession();
        if (!session) return;
        if (!current) {
            session.metadata = null;
            return;
        }
        if (typeof MediaMetadata !== "undefined") {
            session.metadata = new MediaMetadata(buildMediaMetadata(current, { liveAlbum, defaultAlbum }));
        }
        const handlers: Record<PlayerMediaAction, MediaSessionActionHandler> = {
            play: () => controlsRef.current.resume(),
            pause: () => controlsRef.current.pause(),
            stop: () => controlsRef.current.stop(),
            nexttrack: () => controlsRef.current.next(),
            previoustrack: () => controlsRef.current.prev(),
            seekto: (details) => {
                if (typeof details.seekTime === "number") controlsRef.current.seek(details.seekTime * 1000);
            },
            seekbackward: (details) => {
                const step = details.seekOffset ? details.seekOffset * 1000 : MEDIA_SESSION_SEEK_STEP_MS;
                controlsRef.current.seek(Math.max(0, positionRef.current - step));
            },
            seekforward: (details) => {
                const step = details.seekOffset ? details.seekOffset * 1000 : MEDIA_SESSION_SEEK_STEP_MS;
                controlsRef.current.seek(positionRef.current + step);
            },
        };
        const enabled = mediaSessionActions(current.isLive);
        for (const action of ALL_MEDIA_ACTIONS) {
            safeSetHandler(session, action, enabled.includes(action) ? handlers[action] : null);
        }
        return () => {
            for (const action of ALL_MEDIA_ACTIONS) safeSetHandler(session, action, null);
        };
    }, [current, liveAlbum, defaultAlbum]);

    useEffect(() => {
        const session = getSession();
        if (!session) return;
        session.playbackState = current ? (playing ? "playing" : "paused") : "none";
    }, [current, playing]);

    // Bara de progres din lock screen (doar conținut cu durată cunoscută).
    useEffect(() => {
        const session = getSession();
        if (!session || typeof session.setPositionState !== "function") return;
        try {
            if (!current || current.isLive || durationMs <= 0) {
                session.setPositionState();
                return;
            }
            session.setPositionState({
                duration: durationMs / 1000,
                position: Math.min(durationMs, Math.max(0, positionMs)) / 1000,
                playbackRate: 1,
            });
        } catch {
            // poziție invalidă / nesuportat
        }
    }, [current, durationMs, positionMs]);
}
