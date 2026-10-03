/**
 * Prezența Live în Redis (efemeră prin natura ei — fără tabele, fără curățare):
 *  - `live:host:<streamId>`        = sessionId-ul SFU al gazdei, TTL = max(LIVE_HEARTBEAT_TTL,
 *                                    LIVE_HOST_GRACE_SEC) — gazda pe mobil poate trece scurt în
 *                                    fundal (apel, notificare) fără ca streamul să se încheie
 *  - `live:viewers:<streamId>`     = ZSET sessionId → ultimul heartbeat (ms)
 *  - `live:vsession:<sessionId>`   = streamId (leagă sesiunea SFU a spectatorului de stream,
 *                                    ca răspunsul SDP / heartbeat-ul să nu poată atinge altă sesiune)
 */
import { getRedis } from "@/lib/redis";
import { LIVE_CONFIG } from "./config";

const hostKey = (streamId: string) => `live:host:${streamId}`;
const viewersKey = (streamId: string) => `live:viewers:${streamId}`;
const viewerSessionKey = (sessionId: string) => `live:vsession:${sessionId}`;

export async function touchHost(streamId: string, sessionId: string): Promise<void> {
  await getRedis().set(hostKey(streamId), sessionId, "EX", Math.max(LIVE_CONFIG.heartbeatTtlSec, LIVE_CONFIG.hostGraceSec));
}

/** SessionId-ul SFU al gazdei cât timp heartbeat-ul e viu, altfel null. */
export async function hostSession(streamId: string): Promise<string | null> {
  return getRedis().get(hostKey(streamId));
}

export async function registerViewerSession(streamId: string, sessionId: string): Promise<void> {
  await getRedis().set(viewerSessionKey(sessionId), streamId, "EX", LIVE_CONFIG.viewerSessionTtlSec);
}

export async function viewerSessionBelongsTo(streamId: string, sessionId: string): Promise<boolean> {
  return (await getRedis().get(viewerSessionKey(sessionId))) === streamId;
}

export async function touchViewer(streamId: string, sessionId: string): Promise<void> {
  const redis = getRedis();
  await redis.zadd(viewersKey(streamId), Date.now(), sessionId);
  await redis.expire(viewersKey(streamId), LIVE_CONFIG.viewerSessionTtlSec);
}

/** Spectatori cu heartbeat în ultimul TTL (curăță intrările expirate). */
export async function countViewers(streamId: string): Promise<number> {
  const redis = getRedis();
  const cutoff = Date.now() - LIVE_CONFIG.heartbeatTtlSec * 1000;
  await redis.zremrangebyscore(viewersKey(streamId), "-inf", cutoff);
  return redis.zcard(viewersKey(streamId));
}

export async function clearPresence(streamId: string): Promise<void> {
  await getRedis().del(hostKey(streamId), viewersKey(streamId));
}
