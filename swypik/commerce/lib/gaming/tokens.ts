/**
 * HMAC-signed, single-use gaming tokens.
 *
 * Two flows need a token the client cannot forge or replay:
 *   - "session start" tokens (POST /api/gaming/session/start) bind a game
 *     start to a user + timestamp so /api/gaming/score can measure duration
 *     server-side and reject implausibly fast submissions.
 *   - "trivia round" tokens (GET /api/gaming/trivia) bind a round to a user
 *     so /api/gaming/trivia/answer can grade answers server-side without
 *     ever having sent the correct answers to the client.
 *
 * The token itself is a signed, self-contained string (payload.hmac) — same
 * pattern as lib/media/stream-secret.ts / lib/social/session.ts anon
 * cookies. Single-use is enforced with a DB row (token_hash + used_at) since
 * a signature alone can't prevent replay.
 */
import crypto from "crypto";
import { getStreamSecret } from "@/lib/media/stream-secret";

export type GamingTokenPayload = {
  /** "session" | "trivia" */
  kind: string;
  userId: string;
  /** gameId for session tokens, round id for trivia tokens */
  ref: string;
  iat: number;
  exp: number;
  nonce: string;
};

function sign(data: string): string {
  return crypto.createHmac("sha256", getStreamSecret()).update(data).digest("hex");
}

export function issueGamingToken(kind: string, userId: string, ref: string, ttlSeconds: number): string {
  const iat = Date.now();
  const payload: GamingTokenPayload = {
    kind,
    userId,
    ref,
    iat,
    exp: iat + ttlSeconds * 1000,
    nonce: crypto.randomBytes(12).toString("hex"),
  };
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  const sig = sign(b64);
  return `${b64}.${sig}`;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Verify signature + shape + expiry. Does NOT check single-use — callers
 * must check/set the DB row themselves (atomically, via UPDATE ... WHERE
 * used_at IS NULL) to close the race between two concurrent submissions of
 * the same token.
 */
export function verifyGamingToken(token: string | null | undefined, kind: string): GamingTokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(b64);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  let payload: GamingTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || payload.kind !== kind) return null;
  if (typeof payload.userId !== "string" || typeof payload.exp !== "number") return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}
