/**
 * Migrarea activității sociale anonime către contul real, la autentificare.
 *
 * Vizitatorii pot da like (video/produs/comentariu), salva clipuri și urmări
 * creatori sub un user anonim (cookie `anon_session` semnat HMAC). Fără migrare,
 * toată activitatea asta dispărea vizual în momentul autentificării — exact
 * plângerea „like-urile nu se salvează" (audit 2026-08-25).
 *
 * Oglindește tiparul deja existent `mergeAnonCartToUser` (lib/cart).
 *
 * Reguli:
 *  - rândurile care NU există la contul real se mută (UPDATE user_id);
 *  - duplicatele (userul real apreciase deja același lucru) se ȘTERG; contoarele
 *    de like scad prin triggere (20260926_0110), cel de salvări manual;
 *  - totul într-o singură tranzacție: ori migrează tot, ori nimic.
 */

import { withTransaction } from "@/lib/db";
import { logger } from "@/lib/logger";

export async function mergeAnonSocialToUser(
  anonUserId: string,
  realUserId: string,
): Promise<void> {
  if (!anonUserId || !realUserId || anonUserId === realUserId) return;

  try {
    await withTransaction(async (q) => {
      // ── LIKE-uri pe video ────────────────────────────────────────────────
      // Duplicatele se șterg (triggerele scad contoarele), restul se mută.
      // Contoarele (videos.like_count, users.total_likes) scad prin triggere
      // (20260926_0110) — aici NU se mai decrementează manual (era dublă scădere).
      await q(
        `DELETE FROM likes a
         USING likes r
         WHERE a.user_id = $1 AND a.video_id IS NOT NULL
           AND r.user_id = $2 AND r.video_id = a.video_id`,
        [anonUserId, realUserId],
      );
      await q(
        `UPDATE likes SET user_id = $2 WHERE user_id = $1 AND video_id IS NOT NULL`,
        [anonUserId, realUserId],
      );

      // ── LIKE-uri pe comentarii ───────────────────────────────────────────
      await q(
        `DELETE FROM likes a
         USING likes r
         WHERE a.user_id = $1 AND a.comment_id IS NOT NULL
           AND r.user_id = $2 AND r.comment_id = a.comment_id`,
        [anonUserId, realUserId],
      );
      await q(
        `UPDATE likes SET user_id = $2 WHERE user_id = $1 AND comment_id IS NOT NULL`,
        [anonUserId, realUserId],
      );

      // ── LIKE-uri pe produse ──────────────────────────────────────────────
      // product_stats.like_count se recalculează din sursă (COUNT), același
      // procedeu ca în ruta de like — imun la orice drift.
      const { rows: productRows } = await q<{ product_id: string }>(
        `SELECT DISTINCT product_id FROM likes WHERE user_id = $1 AND product_id IS NOT NULL`,
        [anonUserId],
      );
      await q(
        `DELETE FROM likes a
         USING likes r
         WHERE a.user_id = $1 AND a.product_id IS NOT NULL
           AND r.user_id = $2 AND r.product_id = a.product_id`,
        [anonUserId, realUserId],
      );
      await q(
        `UPDATE likes SET user_id = $2 WHERE user_id = $1 AND product_id IS NOT NULL`,
        [anonUserId, realUserId],
      );
      if (productRows.length > 0) {
        await q(
          `UPDATE product_stats ps
              SET like_count = (SELECT COUNT(*) FROM likes l WHERE l.product_id = ps.product_id),
                  updated_at = now()
            WHERE ps.product_id = ANY($1::uuid[])`,
          [productRows.map((row) => row.product_id)],
        );
      }

      // ── Salvări (unique pe user+video+colecție) ──────────────────────────
      await q(
        `WITH dup AS (
           DELETE FROM saves a
           USING saves r
           WHERE a.user_id = $1
             AND r.user_id = $2 AND r.video_id = a.video_id
             AND r.collection_name = a.collection_name
           RETURNING a.video_id
         )
         UPDATE videos v
            SET save_count = GREATEST(v.save_count - d.n, 0)
           FROM (SELECT video_id, COUNT(*)::int AS n FROM dup GROUP BY video_id) d
          WHERE v.id = d.video_id`,
        [anonUserId, realUserId],
      );
      await q(`UPDATE saves SET user_id = $2 WHERE user_id = $1`, [anonUserId, realUserId]);

      // ── Follow-uri (fără contor denormalizat — feed-ul numără live) ──────
      await q(
        `DELETE FROM follows a
         USING follows r
         WHERE a.follower_user_id = $1
           AND r.follower_user_id = $2
           AND r.following_user_id = a.following_user_id`,
        [anonUserId, realUserId],
      );
      // Un follow către contul real însuși ar încălca follows_check.
      await q(
        `DELETE FROM follows WHERE follower_user_id = $1 AND following_user_id = $2`,
        [anonUserId, realUserId],
      );
      await q(
        `UPDATE follows SET follower_user_id = $2 WHERE follower_user_id = $1`,
        [anonUserId, realUserId],
      );
    });
  } catch (err) {
    // Login-ul nu are voie să pice din cauza migrării — activitatea anonimă
    // rămâne pe shell și poate fi migrată la următoarea autentificare.
    logger.warn({ err, anonUserId, realUserId }, "[merge-anon] social merge failed");
  }
}
