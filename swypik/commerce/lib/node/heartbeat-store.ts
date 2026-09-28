/**
 * Stocarea heartbeat-urilor Nodului Local al fiecărui seller (Redis, TTL scurt).
 *
 * Starea nodului e efemeră prin natura ei: dacă nu a bătut de câteva minute,
 * e deconectat. Redis cu expirare modelează exact asta, fără tabelă și fără
 * curățare. Ruta de status citește de aici — nu mai întoarce valori inventate.
 */
import { getRedis } from "@/lib/redis";
import type { NodeHeartbeat } from "./node-protocol";

export const HEARTBEAT_TTL_SECONDS = 120;
const KEY_PREFIX = "seller:node:heartbeat:";

export type StoredHeartbeat = Pick<NodeHeartbeat, "nodeId" | "timestamp" | "pingMs" | "pendingSyncCount">;

export async function recordHeartbeat(sellerId: string, hb: StoredHeartbeat): Promise<void> {
    await getRedis().set(KEY_PREFIX + sellerId, JSON.stringify(hb), "EX", HEARTBEAT_TTL_SECONDS);
}

export async function readHeartbeat(sellerId: string): Promise<StoredHeartbeat | null> {
    const raw = await getRedis().get(KEY_PREFIX + sellerId);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as StoredHeartbeat;
    } catch {
        return null;
    }
}
