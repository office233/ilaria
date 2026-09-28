/**
 * Servere ICE pentru browser: STUN-ul public Cloudflare mereu, plus credențiale
 * TURN de scurtă durată când cheia TURN e configurată (rețele restrictive,
 * NAT simetric). Cheia TURN rămâne pe server.
 */
import { logger } from "@/lib/logger";
import { getSfuConfig, getTurnConfig, stunUrl } from "./config";
import { realtimeFetch } from "./http";

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

// Portul 53 e blocat de browsere și ar întârzia conexiunea până la timeout (docs TURN).
function withoutPort53(server: IceServer): IceServer {
  const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((u) => !/:53(\?|$)/.test(u));
  return { ...server, urls };
}

export async function getIceServers(): Promise<IceServer[]> {
  const stun: IceServer = { urls: [stunUrl()] };
  const turn = getTurnConfig();
  const sfu = getSfuConfig();
  if (!turn || !sfu) return [stun];
  const base = sfu.baseUrl;
  try {
    const res = await realtimeFetch<{ iceServers?: IceServer[] }>(
      `${base}/turn/keys/${encodeURIComponent(turn.keyId)}/credentials/generate-ice-servers`,
      turn.apiToken,
      "POST",
      { ttl: turn.ttlSeconds },
    );
    const servers = (res.iceServers ?? []).map(withoutPort53).filter((s) => (Array.isArray(s.urls) ? s.urls.length > 0 : Boolean(s.urls)));
    return servers.length > 0 ? servers : [stun];
  } catch (err) {
    // Fără TURN, majoritatea rețelelor merg tot prin STUN — nu blocăm transmisia.
    logger.warn({ err }, "[realtime/turn] credential generation failed; STUN only");
    return [stun];
  }
}
