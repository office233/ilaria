/** Apelurile de rețea ale player-ului: URL de redare pentru piesele Swypik și contorul de play-uri. */
import type { TrackDto } from "@/lib/music/types";
import type { MusicLockedInfo } from "./context";

export type PlayUrlOk = { url: string; expiresAt: number | null };
export type PlayUrlLocked = { locked: MusicLockedInfo };
export type PlayUrlResult = PlayUrlOk | PlayUrlLocked | null;

export function isLockedResult(result: PlayUrlOk | PlayUrlLocked): result is PlayUrlLocked {
    return "locked" in result;
}

export async function requestPlayUrl(track: TrackDto): Promise<PlayUrlResult> {
    try {
        const res = await fetch(`/api/music/tracks/${track.slug}/play`, { cache: "no-store" });
        if (res.status === 200) {
            const data = (await res.json()) as { url: string; expiresAt: number | null };
            return { url: data.url, expiresAt: data.expiresAt ?? null };
        }
        if (res.status === 402) {
            const data = (await res.json().catch(() => ({}))) as {
                priceCents?: number | null;
                albumPriceCents?: number | null;
                requireAuth?: boolean;
            };
            return {
                locked: {
                    track,
                    priceCents: data.priceCents ?? null,
                    albumPriceCents: data.albumPriceCents ?? null,
                    requireAuth: Boolean(data.requireAuth),
                },
            };
        }
        return null;
    } catch {
        return null;
    }
}

/** Best-effort — un eșec de rețea nu trebuie să întrerupă redarea. */
export function countPlay(trackId: string): void {
    if (!trackId) return;
    try {
        void fetch("/api/music/plays", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trackId }),
            keepalive: true,
        });
    } catch {
        // ignorat intenționat
    }
}
