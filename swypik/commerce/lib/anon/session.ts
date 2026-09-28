/**
 * Anon session helper — reads/sets `swypik_anon` cookie (UUID v4).
 * Cookie persists 365 days, HttpOnly, SameSite=Lax.
 */
import { cookies, headers } from "next/headers";
import { randomUUID, createHash } from "crypto";
import { dbQuery } from "@/lib/db";

const COOKIE = "swypik_anon";
const MAX_AGE = 60 * 60 * 24 * 365;

function hashOr(v: string | null | undefined): string | null {
  if (!v) return null;
  return createHash("sha256").update(v).digest("hex").slice(0, 32);
}

/**
 * Ensure an anon_id cookie exists, persist `anon_sessions` row, return id.
 * Idempotent: updates last_seen_at on every call.
 */
export async function getOrCreateAnonId(): Promise<string> {
  const jar = await cookies();
  const hdr = await headers();
  let id = jar.get(COOKIE)?.value;
  const valid = id && /^[0-9a-f-]{36}$/i.test(id);
  if (!valid) {
    id = randomUUID();
    jar.set(COOKIE, id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: MAX_AGE,
    });
  }
  const ip = hdr.get("cf-connecting-ip") || hdr.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const ua = hdr.get("user-agent");
  try {
    await dbQuery(
      `INSERT INTO anon_sessions (anon_id, ip_hash, ua_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (anon_id) DO UPDATE
         SET last_seen_at = now(),
             ip_hash = COALESCE(anon_sessions.ip_hash, EXCLUDED.ip_hash),
             ua_hash = COALESCE(anon_sessions.ua_hash, EXCLUDED.ua_hash)`,
      [id, hashOr(ip), hashOr(ua)],
    );
  } catch {
    // best-effort — voting can still proceed even if logging fails
  }
  return id!;
}

/** Read-only — returns current anon id if cookie present and valid, else null. */
export async function readAnonId(): Promise<string | null> {
  const jar = await cookies();
  const id = jar.get(COOKIE)?.value;
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}
