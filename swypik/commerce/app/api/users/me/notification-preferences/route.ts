import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const KEYS = [
  "email_likes","email_comments","email_follows","email_messages","email_sales","email_marketing",
  "push_likes","push_comments","push_follows","push_messages","push_sales",
] as const;
type Key = typeof KEYS[number];

async function fetchOrDefault(userId: string) {
  const { rows } = await dbQuery<Record<string, boolean>>(
    `SELECT ${KEYS.join(",")} FROM notification_preferences WHERE user_id = $1`,
    [userId],
  );
  if (rows[0]) return rows[0];
  await dbQuery(`INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
  const { rows: r2 } = await dbQuery<Record<string, boolean>>(
    `SELECT ${KEYS.join(",")} FROM notification_preferences WHERE user_id = $1`,
    [userId],
  );
  return r2[0];
}

export async function GET() {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const prefs = await fetchOrDefault(session.userId);
  return NextResponse.json({ prefs });
}

export async function PATCH(request: Request) {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rl = await rateLimit("notifPrefs", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  let body: Partial<Record<Key, boolean>>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  await fetchOrDefault(session.userId);

  const sets: string[] = [];
  const vals: unknown[] = [session.userId];
  let i = 2;
  for (const k of KEYS) {
    if (typeof body[k] === "boolean") {
      sets.push(`${k} = $${i++}`);
      vals.push(body[k]);
    }
  }
  if (sets.length === 0) return NextResponse.json({ ok: true, prefs: await fetchOrDefault(session.userId) });
  sets.push("updated_at = now()");
  await dbQuery(`UPDATE notification_preferences SET ${sets.join(", ")} WHERE user_id = $1`, vals);
  return NextResponse.json({ ok: true, prefs: await fetchOrDefault(session.userId) });
}
