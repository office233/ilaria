/**
 * Stratul media Live pe Cloudflare Realtime SFU (fără webhooks la SFU):
 *  - gazda publică (sesiune SFU + track-uri locale) → streamul NU devine live încă;
 *  - heartbeat-ul gazdei (Redis, TTL) + un track local activ în SFU → live;
 *  - spectatorii trag track-urile gazdei (sesiune SFU proprie, legată de stream în Redis);
 *  - încheiere: gazda oprește, sau heartbeat-ul expiră (sweep / verificare leneșă).
 * Toate apelurile SFU trec prin serverul nostru; App Secret-ul nu ajunge în browser.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  createSfuSession,
  getSfuSession,
  hasActiveLocalTrack,
  publishTracks,
  pullTracks,
  renegotiate,
  type LocalTrack,
  type SessionDescription,
} from "@/lib/realtime/sfu";
import { decideTransition } from "./access";
import { publishLiveState } from "./events";
import { markStreamEnded, markStreamLive } from "./lifecycle";
import { clearPresence, countViewers, hostSession, registerViewerSession, touchHost, touchViewer, viewerSessionBelongsTo } from "./presence";
import type { LiveMediaState, LiveStatus, LiveTrack } from "./queries";

export class LiveMediaError extends Error {
  constructor(
    public readonly status: 403 | 409 | 502,
    public readonly code: "forbidden" | "stream_ended" | "session_replaced" | "sfu_failed",
  ) {
    super(code);
    this.name = "LiveMediaError";
  }
}

export type LivePulse = { status: LiveStatus; viewers: number; publishedAt: string | null };

/** live|scheduled → ended + curăță prezența + anunță clienții. */
export async function endLiveStream(streamId: string, opts: { includeScheduled?: boolean } = {}): Promise<boolean> {
  const changed = await markStreamEnded({ streamId }, opts);
  await clearPresence(streamId).catch((err) => logger.warn({ err, streamId }, "[live/media] clear presence failed"));
  if (changed) await publishLiveState(streamId, { status: "ended", viewers: 0 });
  return changed;
}

export async function hostPublish(
  stream: LiveMediaState,
  offer: SessionDescription,
  tracks: LocalTrack[],
): Promise<{ sessionId: string; answer: SessionDescription }> {
  const sessionId = await createSfuSession();
  const res = await publishTracks(sessionId, offer, tracks);
  if (!res.sessionDescription) throw new LiveMediaError(502, "sfu_failed");

  const saved: LiveTrack[] = tracks.map((t) => ({ trackName: t.trackName, mid: t.mid }));
  const { rows } = await dbQuery<{ status: LiveStatus; sfu_published_at: string }>(
    `UPDATE live_streams
        SET provider = 'cf_sfu', sfu_session_id = $2, sfu_tracks = $3::jsonb, sfu_published_at = now()
      WHERE id = $1::uuid AND status IN ('scheduled', 'live')
      RETURNING status, sfu_published_at`,
    [stream.id, sessionId, JSON.stringify(saved)],
  );
  if (!rows[0]) throw new LiveMediaError(409, "stream_ended");
  await touchHost(stream.id, sessionId);
  // Reconectarea gazdei când e deja live: spectatorii trebuie să tragă noua sesiune.
  if (rows[0].status === "live") {
    await publishLiveState(stream.id, { status: "live", publishedAt: rows[0].sfu_published_at });
  }
  return { sessionId, answer: res.sessionDescription };
}

async function mediaActive(sessionId: string): Promise<boolean> {
  try {
    return hasActiveLocalTrack(await getSfuSession(sessionId));
  } catch (err) {
    logger.warn({ err }, "[live/media] SFU session check failed");
    return false;
  }
}

export async function hostHeartbeat(stream: LiveMediaState, sessionId: string): Promise<LivePulse> {
  if (stream.status === "ended" || stream.status === "failed") throw new LiveMediaError(409, "stream_ended");
  // Un tab vechi (sesiune înlocuită de o republicare) nu mai ține streamul în viață.
  if (!stream.sfu_session_id || stream.sfu_session_id !== sessionId) throw new LiveMediaError(409, "session_replaced");
  await touchHost(stream.id, sessionId);

  let status = stream.status;
  const active = status === "scheduled" ? await mediaActive(sessionId) : null;
  if (decideTransition({ status, hostAlive: true, mediaActive: active }) === "go_live") {
    const went = await markStreamLive({ streamId: stream.id, creatorId: stream.creator_id });
    if (went) {
      status = "live";
      await publishLiveState(stream.id, { status: "live", viewers: 0, publishedAt: stream.sfu_published_at });
    }
  }
  const viewers = status === "live" ? await countViewers(stream.id) : 0;
  return { status, viewers, publishedAt: stream.sfu_published_at };
}

export async function viewerWatch(
  stream: LiveMediaState,
): Promise<{ sessionId: string; offer: SessionDescription; tracks: LiveTrack[] }> {
  if (!stream.sfu_session_id || stream.sfu_tracks.length === 0) throw new LiveMediaError(409, "stream_ended");
  const publisher = stream.sfu_session_id;
  const sessionId = await createSfuSession();
  const res = await pullTracks(
    sessionId,
    stream.sfu_tracks.map((t) => ({ location: "remote" as const, sessionId: publisher, trackName: t.trackName })),
  );
  if (!res.sessionDescription) throw new LiveMediaError(502, "sfu_failed");
  await registerViewerSession(stream.id, sessionId);
  await touchViewer(stream.id, sessionId);
  const tracks = (res.tracks ?? [])
    .filter((t): t is { trackName: string; mid: string } => Boolean(t.trackName && t.mid))
    .map((t) => ({ trackName: t.trackName, mid: t.mid }));
  return { sessionId, offer: res.sessionDescription, tracks };
}

export async function viewerAnswer(streamId: string, sessionId: string, answer: SessionDescription): Promise<void> {
  if (!(await viewerSessionBelongsTo(streamId, sessionId))) throw new LiveMediaError(403, "forbidden");
  await renegotiate(sessionId, answer);
}

export async function viewerHeartbeat(stream: LiveMediaState, sessionId: string): Promise<LivePulse> {
  if (!(await viewerSessionBelongsTo(stream.id, sessionId))) throw new LiveMediaError(403, "forbidden");
  if (stream.status !== "live") return { status: stream.status, viewers: 0, publishedAt: stream.sfu_published_at };

  // Verificare leneșă: nu așteptăm sweep-ul ca să închidem un stream abandonat.
  const hostAlive = Boolean(await hostSession(stream.id));
  if (decideTransition({ status: "live", hostAlive, mediaActive: null }) === "end") {
    await endLiveStream(stream.id);
    return { status: "ended", viewers: 0, publishedAt: stream.sfu_published_at };
  }
  await touchViewer(stream.id, sessionId);
  return { status: "live", viewers: await countViewers(stream.id), publishedAt: stream.sfu_published_at };
}
