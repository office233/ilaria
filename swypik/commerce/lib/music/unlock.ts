import { dbQuery, withTransaction } from "@/lib/db";
import { getStripe } from "@/lib/stripe/checkout";
import { creditUserTx, debitUser } from "@/lib/wallet/ledger";
import { logger } from "@/lib/logger";
import { claimUnlockPayment, recordUnlockPaymentOutcome, settleUnmatchedUnlockPayment } from "@/lib/media/unlock-payments";
import { artistShareCents, albumPriceCents } from "./pricing";

export type UnlockIntentResult =
    | { ok: true; alreadyUnlocked: true }
    | { ok: true; alreadyUnlocked: false; clientSecret: string; amountCents: number }
    | { ok: false; reason: "not_found" | "not_premium" | "not_published" | "price_not_set" };

export function musicUnlockRefId(userId: string, target: { trackId: string } | { albumId: string }): string {
    return "trackId" in target
        ? `music_unlock:${userId}:track:${target.trackId}`
        : `music_unlock:${userId}:album:${target.albumId}`;
}

type PendingUnlockRow = { id: string; status: string };

async function upsertPendingTrackUnlock(userId: string, trackId: string, amountCents: number): Promise<PendingUnlockRow> {
    const { rows } = await dbQuery<PendingUnlockRow>(
        `INSERT INTO music_unlocks (user_id, track_id, album_id, units_paid, artist_share_units, amount_cents, currency, status)
         VALUES ($1, $2, NULL, 0, 0, $3, 'RON', 'pending')
         ON CONFLICT (user_id, track_id) WHERE track_id IS NOT NULL
         DO UPDATE SET amount_cents = CASE WHEN music_unlocks.status = 'paid' THEN music_unlocks.amount_cents ELSE EXCLUDED.amount_cents END
         RETURNING id, status`,
        [userId, trackId, amountCents],
    );
    return rows[0];
}

async function upsertPendingAlbumUnlock(userId: string, albumId: string, amountCents: number): Promise<PendingUnlockRow> {
    const { rows } = await dbQuery<PendingUnlockRow>(
        `INSERT INTO music_unlocks (user_id, track_id, album_id, units_paid, artist_share_units, amount_cents, currency, status)
         VALUES ($1, NULL, $2, 0, 0, $3, 'RON', 'pending')
         ON CONFLICT (user_id, album_id) WHERE album_id IS NOT NULL
         DO UPDATE SET amount_cents = CASE WHEN music_unlocks.status = 'paid' THEN music_unlocks.amount_cents ELSE EXCLUDED.amount_cents END
         RETURNING id, status`,
        [userId, albumId, amountCents],
    );
    return rows[0];
}

async function createIntentForUnlock(args: {
    unlockId: string;
    amountCents: number;
    userId: string;
    kind: "music_track_unlock" | "music_album_unlock";
    trackId: string | null;
    albumId: string | null;
}): Promise<string> {
    const stripe = getStripe();
    const intent = await stripe.paymentIntents.create(
        {
            amount: args.amountCents,
            currency: "ron",
            // Doar card: metodele cu redirect cer return_url și scot userul din WebView (MusicPaywall).
            payment_method_types: ["card"],
            metadata: {
                kind: args.kind,
                trackId: args.trackId ?? "",
                albumId: args.albumId ?? "",
                userId: args.userId,
                unlockId: args.unlockId,
            },
        },
        // Cheia include suma: un preț schimbat între încercări creează un intent nou.
        { idempotencyKey: `music_unlock_pi:${args.unlockId}:${args.amountCents}` },
    );
    await dbQuery(
        `UPDATE music_unlocks SET payment_intent_id = $2, amount_cents = $3, status = 'pending' WHERE id = $1 AND status <> 'paid'`,
        [args.unlockId, intent.id, args.amountCents],
    );
    if (!intent.client_secret) throw new Error("stripe_intent_missing_client_secret");
    return intent.client_secret;
}

export async function createTrackUnlockIntent(args: { userId: string; trackId: string }): Promise<UnlockIntentResult> {
    const { rows } = await dbQuery<{ id: string; artist_user_id: string; status: string; is_premium: boolean; price_cents: string | number | null }>(
        `SELECT t.id, t.artist_user_id, t.status, t.is_premium, t.price_cents::text AS price_cents FROM music_tracks t WHERE t.id = $1`,
        [args.trackId],
    );
    const track = rows[0];
    if (!track) return { ok: false, reason: "not_found" };
    if (track.status !== "published") return { ok: false, reason: "not_published" };
    if (!track.is_premium) return { ok: false, reason: "not_premium" };
    const amountCents = track.price_cents === null ? null : Number(track.price_cents);
    if (amountCents === null) return { ok: false, reason: "price_not_set" };

    const pending = await upsertPendingTrackUnlock(args.userId, args.trackId, amountCents);
    if (pending.status === "paid") return { ok: true, alreadyUnlocked: true };

    const clientSecret = await createIntentForUnlock({
        unlockId: pending.id,
        amountCents,
        userId: args.userId,
        kind: "music_track_unlock",
        trackId: args.trackId,
        albumId: null,
    });
    return { ok: true, alreadyUnlocked: false, clientSecret, amountCents };
}

export async function createAlbumUnlockIntent(args: { userId: string; albumId: string }): Promise<UnlockIntentResult> {
    const { rows } = await dbQuery<{ id: string; artist_user_id: string; status: string; price_cents: string | number | null }>(
        `SELECT al.id, al.artist_user_id, al.status, al.price_cents::text AS price_cents FROM music_albums al WHERE al.id = $1`,
        [args.albumId],
    );
    const album = rows[0];
    if (!album) return { ok: false, reason: "not_found" };
    if (album.status !== "published") return { ok: false, reason: "not_published" };

    const { rows: tracks } = await dbQuery<{ is_premium: boolean; price_cents: string | number | null }>(
        `SELECT is_premium, price_cents::text AS price_cents FROM music_tracks WHERE album_id = $1 AND status = 'published'`,
        [args.albumId],
    );
    const amountCents = albumPriceCents(
        { price_cents: album.price_cents === null ? null : Number(album.price_cents) },
        tracks.map((t) => ({ is_premium: t.is_premium, price_cents: t.price_cents === null ? null : Number(t.price_cents) })),
    );
    if (amountCents === null) return { ok: false, reason: "price_not_set" };
    if (amountCents === 0) return { ok: false, reason: "not_premium" };

    const pending = await upsertPendingAlbumUnlock(args.userId, args.albumId, amountCents);
    if (pending.status === "paid") return { ok: true, alreadyUnlocked: true };

    const clientSecret = await createIntentForUnlock({
        unlockId: pending.id,
        amountCents,
        userId: args.userId,
        kind: "music_album_unlock",
        trackId: null,
        albumId: args.albumId,
    });
    return { ok: true, alreadyUnlocked: false, clientSecret, amountCents };
}

/**
 * Webhook `payment_intent.succeeded` (kind `music_track_unlock`/`music_album_unlock`):
 * marchează deblocarea plătită (idempotent — no-op dacă rândul e deja `paid`
 * sau `payment_intent_id` nu se mai potrivește niciunui rând) și creditează
 * cota artistului în cenți RON pe `lib/wallet/ledger.ts` (idempotent după
 * `refType`+`refId`=id-ul rândului de unlock).
 */
export async function markMusicUnlockPaid(args: {
    paymentIntentId: string;
    /** `metadata.unlockId` setat de server la crearea intentului. */
    unlockId: string | null;
    /** Suma efectiv încasată de Stripe (cenți) — sursa de adevăr pentru cota artistului. */
    amountReceivedCents: number;
    currency: string;
}): Promise<void> {
    const { paymentIntentId, unlockId, amountReceivedCents, currency } = args;
    if (currency.toLowerCase() !== "ron" || !(amountReceivedCents > 0)) {
        logger.error({ paymentIntentId, currency, amountReceivedCents }, "[music/unlock] unexpected paid amount/currency — unlock not granted");
        return;
    }
    // O singură procesare per PaymentIntent (cheie primară) — retry-urile Stripe sunt no-op.
    if (!(await claimUnlockPayment({ paymentIntentId, vertical: "music", unlockId, amountCents: amountReceivedCents }))) return;
    type PaidRow = { id: string; user_id: string; track_id: string | null; album_id: string | null; amount_cents: string | null; artist_user_id: string };
    // Plata, cota și creditarea artistului într-O SINGURĂ tranzacție: o creditare eșuată
    // anulează totul, rezultatul rămâne `processing`, iar retry-ul Stripe reia procesarea.
    const row = await withTransaction(async (q) => {
        const { rows } = await q<PaidRow>(
            `UPDATE music_unlocks u
                SET status = 'paid', paid_at = now(), payment_intent_id = $1
               FROM (
                    SELECT id, artist_user_id FROM music_tracks
                    UNION ALL
                    SELECT id, artist_user_id FROM music_albums
                ) owner(id, artist_user_id)
              WHERE owner.id = COALESCE(u.track_id, u.album_id) AND u.status <> 'paid'
                AND (u.payment_intent_id = $1 OR u.id::text = $2)
              RETURNING u.id, u.user_id, u.track_id, u.album_id, u.amount_cents::text AS amount_cents, owner.artist_user_id`,
            [paymentIntentId, unlockId ?? ""],
        );
        const paid = rows[0];
        if (!paid) return null;
        if (Number(paid.amount_cents ?? 0) !== amountReceivedCents) {
            logger.warn({ unlockId: paid.id, stored: paid.amount_cents, received: amountReceivedCents }, "[music/unlock] paid amount differs from stored price — using Stripe amount");
        }
        const share = artistShareCents(amountReceivedCents, paid.artist_user_id, paid.user_id);
        await q(`UPDATE music_unlocks SET amount_cents = $2, units_paid = $2, artist_share_units = $3 WHERE id = $1`, [paid.id, amountReceivedCents, share]);
        if (share > 0) {
            await creditUserTx(q, {
                userId: paid.artist_user_id,
                amountCents: share,
                refType: "music_artist_share",
                refId: paid.id,
                description: "Swypik Music — cotă artist",
                metadata: { trackId: paid.track_id, albumId: paid.album_id },
            });
        }
        return paid;
    }).catch((err) => {
        logger.error({ err, paymentIntentId }, "[music/unlock] grant + artist share failed — retried by the webhook");
        throw err;
    });
    if (!row) {
        const { rows: current } = await dbQuery<{ status: string; payment_intent_id: string | null }>(
            `SELECT status, payment_intent_id FROM music_unlocks WHERE payment_intent_id = $1 OR id::text = $2 ORDER BY (status = 'paid') DESC LIMIT 1`,
            [paymentIntentId, unlockId ?? ""],
        );
        await settleUnmatchedUnlockPayment({ paymentIntentId, vertical: "music", unlockId, current: current[0] ?? null });
        return;
    }
    await recordUnlockPaymentOutcome(paymentIntentId, "granted");
}

/**
 * Refund total sau dispută pierdută pentru o deblocare plătită cu cardul:
 * accesul se revocă (status `refunded`) și cota artistului se retrage din
 * portofelul RON (poate duce soldul pe minus; idempotent pe id-ul deblocării).
 * Întoarce true dacă plata aparținea unei deblocări Music.
 */
export async function revokeMusicUnlockForPayment(paymentIntentId: string, reason: string): Promise<boolean> {
    const { rows } = await dbQuery<{ id: string; owner_id: string; share: string | null }>(
        `UPDATE music_unlocks u
            SET status = 'refunded'
           FROM (
                SELECT id, artist_user_id FROM music_tracks
                UNION ALL
                SELECT id, artist_user_id FROM music_albums
            ) owner(id, artist_user_id)
          WHERE owner.id = COALESCE(u.track_id, u.album_id) AND u.payment_intent_id = $1 AND u.status = 'paid'
          RETURNING u.id, owner.artist_user_id AS owner_id, u.artist_share_units::text AS share`,
        [paymentIntentId],
    );
    const row = rows[0];
    if (!row) {
        const known = await dbQuery(`SELECT 1 FROM music_unlocks WHERE payment_intent_id = $1 LIMIT 1`, [paymentIntentId]);
        return known.rows.length > 0;
    }
    const share = Number(row.share ?? 0);
    if (share > 0) {
        await debitUser({
            userId: row.owner_id,
            amountCents: share,
            refType: "music_artist_share_reversal",
            refId: row.id,
            description: "Swypik Music — cotă artist retrasă (refund/dispută)",
            metadata: { paymentIntentId, reason },
            negativeBalanceReason: "settlement_reversal",
        }).catch((err) => logger.error({ err, unlockId: row.id }, "[music/unlock] share reversal failed"));
    }
    logger.info({ unlockId: row.id, paymentIntentId, reason }, "[music/unlock] unlock revoked");
    return true;
}
