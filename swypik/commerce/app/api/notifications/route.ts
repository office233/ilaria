import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getOptionalSocialUserId } from "@/lib/social/session";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  user_id: string;
  actor_user_id: string | null;
  notification_type: string;
  title: string;
  body: string | null;
  video_id: string | null;
  comment_id: string | null;
  action_url: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
  actor_username: string | null;
  actor_display_name: string | null;
  actor_avatar_url: string | null;
  cursor_ts: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Filtrul de blocare, identic pentru listă și pentru numărul de necitite. */
const NOT_BLOCKED = `NOT EXISTS (
          SELECT 1 FROM user_blocks ub
           WHERE ub.blocker_user_id = n.user_id AND ub.blocked_user_id = n.actor_user_id
        )`;

async function GET_impl(request: Request) {
  const userId = await getOptionalSocialUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const limitParam = Number(url.searchParams.get("limit") || "20");
  const limit = Math.min(Math.max(limitParam || 20, 1), 50);

  // Cursor keyset (created_at cu precizie de microsecunde + id): cursorul vechi
  // (doar created_at, trunchiat la ms de JSON) sărea rânduri cu aceeași milisecundă.
  const params: unknown[] = [userId];
  let cursorClause = "";
  if (cursor) {
    const [ts, id] = cursor.split("|");
    if (!ts || Number.isNaN(Date.parse(ts))) {
      return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
    }
    if (id && UUID_RE.test(id)) {
      cursorClause = ` AND (n.created_at, n.id) < ($2::timestamptz, $3::uuid)`;
      params.push(ts, id);
    } else {
      cursorClause = ` AND n.created_at < $2::timestamptz`;
      params.push(ts);
    }
  }
  params.push(limit + 1);

  const { rows } = await dbQuery<Row>(
    // Actorul (avatar + nume) pentru rândurile din listă — fără notificări de la
    // conturi care între timp au fost blocate de destinatar.
    `SELECT n.id, n.user_id, n.actor_user_id, n.notification_type, n.title, n.body,
            n.video_id, n.comment_id, n.action_url, n.metadata, n.read_at, n.created_at,
            a.username AS actor_username, a.display_name AS actor_display_name,
            a.avatar_url AS actor_avatar_url, to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
       FROM notifications n
       LEFT JOIN users a ON a.id = n.actor_user_id
      WHERE n.user_id = $1${cursorClause}
        AND ${NOT_BLOCKED}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.cursor_ts}|${last.id}` : null;
  const items = page.map(({ cursor_ts: _cursor, ...rest }) => rest);

  // Necititele numără DOAR ce apare în listă (fără actorii blocați).
  const { rows: unreadRows } = await dbQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM notifications n
      WHERE n.user_id = $1 AND n.read_at IS NULL
        AND ${NOT_BLOCKED}`,
    [userId],
  );

  return NextResponse.json({
    items,
    nextCursor,
    unreadCount: Number(unreadRows[0]?.count || "0"),
  });
}

export const GET = withErrorHandling(GET_impl);
