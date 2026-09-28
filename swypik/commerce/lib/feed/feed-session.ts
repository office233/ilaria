/**
 * Sesiune de feed anonimă semnată (`feed_sid`, httpOnly).
 *
 * Emisă de GET /api/explore/feed pentru vizitatorii fără cont și fără shell
 * anonim. Rutele de ingest (/api/feed/event, /api/feed/events/batch) acceptă
 * evenimente anonime DOAR cu acest token valid — `session_id` din body e
 * controlat de client și nu mai e sursă de identitate (audit feed-algorithm).
 */
import crypto from "crypto";
import { getAnonSigningKey } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { ABUSE_LIMITS } from "@/lib/security/abuse-limits";

export const FEED_SESSION_COOKIE = "feed_sid";
const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAC_LEN = 32;
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function mac(sid: string): string {
  return crypto
    .createHmac("sha256", getAnonSigningKey())
    .update(`feed-session:${sid}`)
    .digest("hex")
    .slice(0, MAC_LEN);
}

export function isValidFeedSid(sid: unknown): sid is string {
  return typeof sid === "string" && SID_RE.test(sid);
}

export function signFeedSession(sid: string): string {
  if (!isValidFeedSid(sid)) throw new Error("invalid feed session id");
  return `${sid}.${mac(sid)}`;
}

/** Întoarce sid-ul iff semnătura e validă. */
export function verifyFeedSession(value: string | null | undefined): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const sid = value.slice(0, dot);
  const given = value.slice(dot + 1);
  if (!isValidFeedSid(sid) || given.length !== MAC_LEN) return null;
  try {
    const a = Buffer.from(given, "hex");
    const b = Buffer.from(mac(sid), "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return sid;
}

type CookieWritable = {
  cookies?: { set: (name: string, value: string, options: Record<string, unknown>) => void };
};

export type FeedSessionDecision = {
  /** sid-ul folosit pentru viewer (verificat sau proaspăt emis), null dacă nu există. */
  sid: string | null;
  /** true = sid-ul trebuie scris în cookie pe răspuns. */
  issue: boolean;
};

/**
 * Pentru un vizitator fără identitate socială: refolosește `feed_sid` valid
 * sau emite unul nou (legat de session_id-ul clientului, dacă are format valid),
 * cu limită de emitere per IP.
 */
export async function resolveOrIssueFeedSession(
  cookieValue: string | null | undefined,
  clientSid: string | null,
  ip: string,
): Promise<FeedSessionDecision> {
  const existing = verifyFeedSession(cookieValue);
  if (existing) return { sid: existing, issue: false };
  const mint = await rateLimit("feed_session_mint", ip, ABUSE_LIMITS.feedSessionMint);
  if (!mint.success) return { sid: null, issue: false };
  const sid = isValidFeedSid(clientSid) ? clientSid : crypto.randomUUID();
  return { sid, issue: true };
}

export function setFeedSessionCookie(response: Response, sid: string): void {
  const res = response as Response & CookieWritable;
  res.cookies?.set(FEED_SESSION_COOKIE, signFeedSession(sid), {
    path: "/",
    maxAge: MAX_AGE_SECONDS,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
