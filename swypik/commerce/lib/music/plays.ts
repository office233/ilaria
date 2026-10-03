/**
 * Contorul de plays ca vector de umflare a Top 10 (Review Focus #5): un play
 * se numără o singură dată per (IP, piesă) într-o fereastră de dedup, marcată
 * în Redis cu SET NX. Funcții pure față de client-ul Redis (structural typed),
 * ușor de testat fără server real.
 */
import { MUSIC_PLAY_DEDUP_TTL_S } from "./config";

export type PlayDedupClient = {
    set(key: string, value: string, mode: "EX", ttl: number, flag: "NX"): Promise<unknown>;
};

export function playDedupKey(ip: string, trackId: string): string {
    return `music:play:${ip}:${trackId}`;
}

/** `true` doar când SET NX a reușit (prima cerere din fereastră pentru acest (IP, piesă)). */
export async function shouldCountPlay(
    client: PlayDedupClient,
    ip: string,
    trackId: string,
    ttlS: number = MUSIC_PLAY_DEDUP_TTL_S,
): Promise<boolean> {
    const result = await client.set(playDedupKey(ip, trackId), "1", "EX", ttlS, "NX");
    return result === "OK";
}
