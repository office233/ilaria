import { NextResponse } from "next/server";
import { getDb, dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { anonSessionErrorResponse, getOrCreateSocialUser, setAnonSessionCookie } from "@/lib/social/session";
import { logger } from "@/lib/logger";
import { UUID_RE } from "@/lib/validation/uuid";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { isVideoInteractableTx } from "@/lib/video/interactable";

export const dynamic = "force-dynamic";

function normalizeCollectionName(value: unknown): string {
  if (typeof value !== "string") return "default";
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 48) || "default";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // 2026-08-25: aliniat cu like-urile — salvarea merge și anonim (cookie
    // semnat), migrată la contul real la login prin mergeAnonSocialToUser.
    // Semnalul de ranking se emite doar pentru sesiuni autentificate complet.
    const { userId, anonSessionId } = await getOrCreateSocialUser();
    const authSession = await getAuthSession().catch(() => null);
    const { id: videoId } = await params;
    if (!UUID_RE.test(videoId)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

    const rl = await rateLimit("videoSave", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const rlIp = await rateLimit("videoSave", `ip:${getClientIP(request)}`, { limit: 30, window: 60 });
    if (!rlIp.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    let body: any = {};
    try { body = await request.json(); } catch {}
    const collectionName = normalizeCollectionName(body.collection_name);

    const pool = getDb();
    const client = await pool.connect();
    let saved = false;
    let saveCount = 0;

    try {
      await client.query("BEGIN");

      const checkRes = await client.query(
        "SELECT id FROM saves WHERE user_id = $1 AND video_id = $2 AND collection_name = $3",
        [userId, videoId, collectionName]
      );

      if (checkRes.rows.length > 0) {
        // RETURNING + rowCount: două unsave-uri concurente nu decrementează
        // amândouă contorul (același fix ca la like, audit 2026-08-25).
        const delRes = await client.query(
          "DELETE FROM saves WHERE user_id = $1 AND video_id = $2 AND collection_name = $3 RETURNING id",
          [userId, videoId, collectionName]
        );
        if ((delRes.rowCount ?? 0) > 0) {
          const countRes = await client.query(
            "UPDATE videos SET save_count = GREATEST(save_count - 1, 0) WHERE id = $1 RETURNING save_count",
            [videoId]
          );
          await client.query(
            `UPDATE user_collections SET item_count = GREATEST(item_count - 1, 0) WHERE user_id = $1 AND slug = $2`,
            [userId, collectionName]
          );
          saveCount = parseInt(countRes.rows[0]?.save_count || "0", 10);
        } else {
          const curRes = await client.query("SELECT save_count FROM videos WHERE id = $1", [videoId]);
          saveCount = parseInt(curRes.rows[0]?.save_count || "0", 10);
        }
        saved = false;
      } else {
        // P2-01: salvare NOUĂ doar pe conținut încă vizibil. Ștergerea din
        // colecție (ramura de mai sus) rămâne mereu permisă.
        if (!(await isVideoInteractableTx(client, videoId))) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "video_not_available" }, { status: 404 });
        }
        // ON CONFLICT: dublu-tap concurent nu mai lovea indexul unic cu 500 și
        // nu mai incrementa contorul de două ori.
        const insertRes = await client.query(
          `INSERT INTO saves (user_id, video_id, collection_name) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, video_id, collection_name) DO NOTHING RETURNING id`,
          [userId, videoId, collectionName]
        );
        if ((insertRes.rowCount ?? 0) > 0) {
          const countRes = await client.query(
            "UPDATE videos SET save_count = save_count + 1 WHERE id = $1 RETURNING save_count",
            [videoId]
          );
          await client.query(
            `UPDATE user_collections SET item_count = item_count + 1 WHERE user_id = $1 AND slug = $2`,
            [userId, collectionName]
          );
          // 'save' (nu legacy 'video_saved') — e tipul numărat de ranking
          // (pondere ×3 în video_rank_14d); cel vechi era invizibil pentru
          // algoritm, exact ca 'video_liked' la like-uri. Doar actori
          // autentificați complet (anti-fraudă ranking).
          if (authSession?.userId) {
            await client.query(
              `INSERT INTO feed_events (actor_user_id, video_id, event_type, audience, score, source, metadata)
               VALUES ($1, $2, 'save', 'global', 4, 'next-save', $3::jsonb)`,
              [authSession.userId, videoId, JSON.stringify({ collection_name: collectionName })]
            );
          }
          saveCount = parseInt(countRes.rows[0]?.save_count || "0", 10);
        } else {
          const curRes = await client.query("SELECT save_count FROM videos WHERE id = $1", [videoId]);
          saveCount = parseInt(curRes.rows[0]?.save_count || "0", 10);
        }
        saved = true;
      }

      await client.query("COMMIT");

      const response = NextResponse.json({ saved, collection_name: collectionName, save_count: saveCount });
      setAnonSessionCookie(response, anonSessionId);
      return response;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (error: any) {
    const anonErr = anonSessionErrorResponse(error);
    if (anonErr) return anonErr;
    logger.error({ err: error }, "[Save API] POST Error:");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getAuthSession();
    const userId = session?.userId || null;
    const { id: videoId } = await params;
    if (!UUID_RE.test(videoId)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

    const [savesRes, videoRes] = await Promise.all([
      userId
        ? dbQuery("SELECT collection_name FROM saves WHERE user_id = $1 AND video_id = $2", [userId, videoId])
        : Promise.resolve({ rows: [], rowCount: 0 }),
      dbQuery("SELECT save_count FROM videos WHERE id = $1", [videoId])
    ]);

    const collections = savesRes.rows.map((r: any) => r.collection_name);
    const saved = collections.length > 0;
    const saveCount = parseInt(videoRes.rows[0]?.save_count || "0", 10);

    return NextResponse.json({ saved, collections, save_count: saveCount });
  } catch (error: any) {
    logger.error({ err: error }, "[Save API] GET Error:");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export const DELETE = POST;
