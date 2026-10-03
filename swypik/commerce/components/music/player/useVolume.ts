"use client";

/** Volum + mute ale player-ului, persistate în localStorage și aplicate pe `<audio>`. */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { MUSIC_VOLUME_STORAGE_KEY } from "@/lib/music/player/config";

function persistVolume(vol: number, isMuted: boolean): void {
    try {
        localStorage.setItem(MUSIC_VOLUME_STORAGE_KEY, JSON.stringify({ volume: vol, muted: isMuted }));
    } catch {
        // ignorat (localStorage indisponibil — mod privat etc.)
    }
}

export function useVolume(audioRef: RefObject<HTMLAudioElement | null>) {
    const [volume, setVolumeValue] = useState(1);
    const [muted, setMutedValue] = useState(false);
    const volumeRef = useRef(volume);
    const mutedRef = useRef(muted);

    useEffect(() => { volumeRef.current = volume; }, [volume]);
    useEffect(() => { mutedRef.current = muted; }, [muted]);

    const applyToAudio = useCallback((vol: number, isMuted: boolean) => {
        const audio = audioRef.current;
        if (audio) audio.volume = isMuted ? 0 : vol;
    }, [audioRef]);

    const setVolume = useCallback((value: number) => {
        const clamped = Math.min(1, Math.max(0, value));
        setVolumeValue(clamped);
        setMutedValue(false);
        applyToAudio(clamped, false);
        persistVolume(clamped, false);
    }, [applyToAudio]);

    const setMuted = useCallback((value: boolean) => {
        setMutedValue(value);
        applyToAudio(volumeRef.current, value);
        persistVolume(volumeRef.current, value);
    }, [applyToAudio]);

    /** Reaplică volumul curent (la fiecare piesă nouă). */
    const reapply = useCallback(() => applyToAudio(volumeRef.current, mutedRef.current), [applyToAudio]);

    // Volum persistat: citit o singură dată la montare (try/catch — poate lipsi/fi corupt).
    useEffect(() => {
        try {
            const raw = localStorage.getItem(MUSIC_VOLUME_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as { volume?: unknown; muted?: unknown };
            const vol = typeof parsed.volume === "number" && Number.isFinite(parsed.volume) ? Math.min(1, Math.max(0, parsed.volume)) : 1;
            const isMuted = typeof parsed.muted === "boolean" ? parsed.muted : false;
            setVolumeValue(vol);
            setMutedValue(isMuted);
            applyToAudio(vol, isMuted);
        } catch {
            // ignorat
        }
    }, [applyToAudio]);

    return { volume, muted, setVolume, setMuted, reapply };
}
