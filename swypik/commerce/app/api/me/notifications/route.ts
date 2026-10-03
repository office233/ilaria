/**
 * Notification poll endpoint.
 * GET  — recent 30, unread first.
 * POST — body: { ids?: string[]; markAll?: boolean } → mark read.
 */

import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { rateLimit } from "@/lib/security/rate-limit";
import { NotificationsMarkReadSchema, parseBody } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getAuthUser();
  if (!user.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const { rows } = await dbQuery<{
      id: string;
      kind: string;
      title: string;
      body: string | null;
      ref_type: string | null;
      ref_id: string | null;
      cta_url: string | null;
      read_at: string | null;
      created_at: string;
    }>(
      `SELECT id::text, kind, title, body, ref_type, ref_id::text, cta_url, read_at, created_at
         FROM notifications
        WHERE user_id = $1
        ORDER BY (read_at IS NOT NULL), created_at DESC
        LIMIT 30`,
      [user.userId],
    );

    const { rows: countRows } = await dbQuery<{ unread: string }>(
      `SELECT COUNT(*)::text AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [user.userId],
    );

    return NextResponse.json(
      {
        unread: Number(countRows[0]?.unread || 0),
        notifications: rows.map((n) => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          body: n.body,
          refType: n.ref_type,
          refId: n.ref_id,
          ctaUrl: n.cta_url,
          readAt: n.read_at,
          createdAt: n.created_at,
        })),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { unread: 0, notifications: [], error: (err as Error).message },
      { status: 200 },
    );
  }
}

export async function POST(req: Request) {
  const user = await getAuthUser();
  if (!user.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = await rateLimit("notifications", user.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const rawBody = await req.json().catch(() => ({}));
  const parsed = parseBody(NotificationsMarkReadSchema, rawBody);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, issues: parsed.issues }, { status: 400 });
  }

  try {
    if ("markAll" in parsed.data) {
      await dbQuery(
        `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
        [user.userId],
      );
    } else {
      const ids = parsed.data.ids.map(Number);
      await dbQuery(
        `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL`,
        [user.userId, ids],
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
