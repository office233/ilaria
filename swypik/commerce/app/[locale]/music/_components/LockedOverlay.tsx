"use client";

/**
 * Modal peste tot ecranul care afișează `MusicPaywall` când player-ul global
 * a dat peste o piesă premium neblocată de viewer (`useMusicPlayer().locked`).
 * `MusicPaywall` e doar un card fără poziționare proprie — acest wrapper îl
 * portal-ează cu fundal, la fel ca `TipSheet`.
 */
import { createPortal } from "react-dom";
import MusicPaywall from "@/components/music/MusicPaywall";
import { useMusicPlayer } from "@/components/music/MusicPlayerProvider";

export default function LockedOverlay({ albumSlug }: { albumSlug?: string }) {
    const { locked, dismissLocked, play } = useMusicPlayer();
    if (!locked || typeof document === "undefined") return null;

    return createPortal(
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 px-5">
            <div className="w-full max-w-sm">
                <MusicPaywall
                    locked={locked}
                    albumSlug={albumSlug}
                    onClose={dismissLocked}
                    onUnlocked={() => play([locked.track], 0)}
                />
            </div>
        </div>,
        document.body,
    );
}
