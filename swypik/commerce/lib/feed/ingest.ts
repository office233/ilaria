/**
 * Pipeline comun de ingest pentru /api/feed/event și /api/feed/events/batch:
 * identitate verificată → rate limit → normalizare → gărzi anti-manipulare → INSERT.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getSocialIdentity } from "@/lib/social/session";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { ABUSE_LIMITS, FEED_EVENT_CAPS } from "@/lib/security/abuse-limits";
import { FEED_SESSION_COOKIE, verifyFeedSession } from "@/lib/feed/feed-session";
import { applyFeedEventGuards, capKey } from "@/lib/feed/event-guards";
import type { FeedEventType } from "@/lib/feed/event-types";
import { hashIp, insertFeedEvents, normalizeFeedEvent, type NormalizedFeedEvent } from "@/lib/feed/events";

export type FeedIdentity =
  | { kind: "user"; userId: string; isAccount: boolean }
  | { kind: "feed_session"; sid: string };

export type IngestOutcome =
  | { status: "unauthorized" }
  | { status: "rate_limited" }
  | { status: "ok"; inserted: number; rejected: number; errors: { index: number; error: string }[] };

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function resolveFeedIdentity(req: Request): Promise<FeedIdentity | null> {
  const social = await getSocialIdentity().catch(() => null);
  if (social) return { kind: "user", userId: social.userId, isAccount: !social.isAnon };
  const sid = verifyFeedSession(readCookie(req, FEED_SESSION_COOKIE));
  return sid ? { kind: "feed_session", sid } : null;
}

async function loadVideoDurations(ids: string[]): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>();
  if (ids.length === 0) return map;
  const { rows } = await dbQuery<{ id: string; duration_ms: number | null }>(
    `SELECT id, duration_ms FROM videos WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  for (const r of rows) map.set(r.id, r.duration_ms == null ? null : Number(r.duration_ms));
  return map;
}

async function loadPriorCounts(identity: FeedIdentity, ids: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (ids.length === 0) return map;
  const who =
    identity.kind === "user"
      ? `actor_user_id = $3`
      : `actor_user_id IS NULL AND session_id = $3`;
  const { rows } = await dbQuery<{ video_id: string; event_type: FeedEventType; n: number }>(
    `SELECT video_id, event_type, count(*)::int AS n
       FROM feed_events
      WHERE video_id = ANY($1::uuid[])
        AND occurred_at > NOW() - make_interval(hours => $2::int)
        AND ${who}
      GROUP BY video_id, event_type`,
    [ids, FEED_EVENT_CAPS.windowHours, identity.kind === "user" ? identity.userId : identity.sid],
  );
  for (const r of rows) map.set(capKey(r.video_id, r.event_type), Number(r.n));
  return map;
}

export async function ingestFeedEvents(req: Request, rawEvents: unknown[]): Promise<IngestOutcome> {
  const ip = getClientIP(req);
  const ipLimit = await rateLimit("feed_event_batch", ip, { limit: 20, window: 60 });
  if (!ipLimit.success) return { status: "rate_limited" };

  const identity = await resolveFeedIdentity(req);
  if (!identity) return { status: "unauthorized" };

  const identityKey = identity.kind === "user" ? `u:${identity.userId}` : `s:${identity.sid}`;
  const idLimit = await rateLimit("feed_event_identity", identityKey, ABUSE_LIMITS.feedEventsPerIdentity);
  if (!idLimit.success) return { status: "rate_limited" };

  // Sesiunea anonimă e cea semnată de server — session_id din body e ignorat.
  const fallbackSession = identity.kind === "user" ? identity.userId : identity.sid;
  const normalized: NormalizedFeedEvent[] = [];
  const errors: { index: number; error: string }[] = [];
  rawEvents.forEach((raw, index) => {
    const r = normalizeFeedEvent(raw, fallbackSession);
    if ("error" in r) errors.push({ index, error: r.error });
    else normalized.push(identity.kind === "feed_session" ? { ...r, session_id: identity.sid } : r);
  });
  if (normalized.length === 0) return { status: "ok", inserted: 0, rejected: errors.length, errors };

  const ids = Array.from(new Set(normalized.map((e) => e.video_id).filter((v): v is string => Boolean(v))));
  const [videos, priorCounts] = await Promise.all([loadVideoDurations(ids), loadPriorCounts(identity, ids)]);
  const { accepted, dropped } = applyFeedEventGuards(normalized, {
    isAccount: identity.kind === "user" && identity.isAccount,
    videos,
    priorCounts,
  });

  const inserted = accepted.length
    ? await insertFeedEvents(accepted, {
        userId: identity.kind === "user" ? identity.userId : null,
        ipHash: hashIp(ip),
        country: req.headers.get("cf-ipcountry") || null,
      })
    : 0;
  if (dropped > 0) logger.debug({ dropped, identity: identity.kind }, "[feed/ingest] events dropped by guards");
  return { status: "ok", inserted, rejected: errors.length + dropped, errors };
}
