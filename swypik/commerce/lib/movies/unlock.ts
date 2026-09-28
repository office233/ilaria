import { dbQuery, withTransaction } from "@/lib/db";
import { getStripe } from "@/lib/stripe/checkout";
import { creditUserTx, debitUser } from "@/lib/wallet/ledger";
import { logger } from "@/lib/logger";
import { claimUnlockPayment, recordUnlockPaymentOutcome, settleUnmatchedUnlockPayment } from "@/lib/media/unlock-payments";
import { isFreeEpisode, isSeriesPublic } from "./access";
import { creatorShareCents, seasonPriceCents } from "./pricing";

export type UnlockIntentResult =
    | { ok: true; alreadyUnlocked: true }
    | { ok: true; alreadyUnlocked: false; clientSecret: string; amountCents: number }
    | { ok: false; reason: "not_found" | "already_free" | "series_not_published" | "price_not_set" };

export function unlockRefId(userId: string, target: { episodeId: string } | { seriesId: string }): string {
    return "episodeId" in target
        ? `movie_unlock:${userId}:episode:${target.episodeId}`
        : `movie_unlock:${userId}:season:${target.seriesId}`;
}

type PendingUnlockRow = { id: string; status: string };

async function upsertPendingEpisodeUnlock(userId: string, seriesId: string, episodeId: string, amountCents: number): Promise<PendingUnlockRow> {
    const { rows } = await dbQuery<PendingUnlockRow>(
        `INSERT INTO movie_unlocks (user_id, series_id, episode_id, units_paid, creator_share_units, amount_cents, currency, status)
         VALUES ($1, $2, $3, 0, 0, $4, 'RON', 'pending')
         ON CONFLICT (user_id, episode_id) WHERE episode_id IS NOT NULL
         DO UPDATE SET amount_cents = CASE WHEN movie_unlocks.status = 'paid' THEN movie_unlocks.amount_cents ELSE EXCLUDED.amount_cents END
         RETURNING id, status`,
        [userId, seriesId, episodeId, amountCents],
    );
    return rows[0];
}

async function upsertPendingSeasonUnlock(userId: string, seriesId: string, amountCents: number): Promise<PendingUnlockRow> {
    const { rows } = await dbQuery<PendingUnlockRow>(
        `INSERT INTO movie_unlocks (user_id, series_id, episode_id, units_paid, creator_share_units, amount_cents, currency, status)
         VALUES ($1, $2, NULL, 0, 0, $3, 'RON', 'pending')
         ON CONFLICT (user_id, series_id) WHERE episode_id IS NULL
         DO UPDATE SET amount_cents = CASE WHEN movie_unlocks.status = 'paid' THEN movie_unlocks.amount_cents ELSE EXCLUDED.amount_cents END
         RETURNING id, status`,
        [userId, seriesId, amountCents],
    );
    return rows[0];
}

async function createIntentForUnlock(args: {
    unlockId: string;
    amountCents: number;
    seriesId: string;
    episodeId: string | null;
    userId: string;
    kindMetadata: Record<string, string>;
}): Promise<string> {
    const stripe = getStripe();
    const intent = await stripe.paymentIntents.create(
        {
            amount: args.amountCents,
            currency: "ron",
            // Doar card: metodele cu redirect (automatic_payment_methods) cer return_url și
            // scot userul din WebView-ul aplicației (vezi UnlockConfirmForm).
            payment_method_types: ["card"],
            metadata: {
                kind: "movie_unlock",
                seriesId: args.seriesId,
                episodeId: args.episodeId ?? "",
                userId: args.userId,
                unlockId: args.unlockId,
                ...args.kindMetadata,
            },
        },
        // Cheia include suma: dacă prețul se schimbă între două încercări, Stripe
        // creează un intent nou în loc să respingă cererea (params diferiți, aceeași cheie).
        { idempotencyKey: `movie_unlock_pi:${args.unlockId}:${args.amountCents}` },
    );
    await dbQuery(
        `UPDATE movie_unlocks SET payment_intent_id = $2, amount_cents = $3, status = 'pending' WHERE id = $1 AND status <> 'paid'`,
        [args.unlockId, intent.id, args.amountCents],
    );
    if (!intent.client_secret) throw new Error("stripe_intent_missing_client_secret");
    return intent.client_secret;
}

type SeriesStatusValue = "draft" | "pending_review" | "published" | "archived";

/**
 * `seriesId` = titlul din URL (slug): episodul trebuie să-i aparțină — altfel
 * se putea plăti de pe pagina unui titlu un episod din alt titlu.
 * Un titlu cu licența expirată nu se mai poate cumpăra (ar plăti, apoi 404).
 */
export async function createEpisodeUnlockIntent(args: { userId: string; episodeId: string; seriesId: string }): Promise<UnlockIntentResult> {
    const { rows } = await dbQuery<{
        episode_number: number;
        series_id: string;
        id: string;
        owner_user_id: string;
        status: SeriesStatusValue;
        license_expires_at: string | null;
        free_episodes: number;
        episode_price_cents: string | number | null;
    }>(
        `SELECT e.episode_number, e.series_id, s.id, s.owner_user_id, s.status, s.license_expires_at::text AS license_expires_at,
                s.free_episodes, s.episode_price_cents::text AS episode_price_cents
           FROM movie_episodes e JOIN movie_series s ON s.id = e.series_id
          WHERE e.id = $1 AND e.series_id = $2 AND e.status = 'published'`,
        [args.episodeId, args.seriesId],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: "not_found" };
    if (!isSeriesPublic(row)) return { ok: false, reason: "series_not_published" };
    if (isFreeEpisode(row, row)) return { ok: false, reason: "already_free" };
    const amountCents = row.episode_price_cents === null ? null : Number(row.episode_price_cents);
    if (amountCents === null) return { ok: false, reason: "price_not_set" };
    // Sezonul întreg deja plătit acoperă episodul — nu mai cerem o plată.
    const { rows: season } = await dbQuery(
        `SELECT 1 FROM movie_unlocks WHERE user_id = $1 AND series_id = $2 AND episode_id IS NULL AND status = 'paid'`,
        [args.userId, row.series_id],
    );
    if (season.length > 0) return { ok: true, alreadyUnlocked: true };

    const pending = await upsertPendingEpisodeUnlock(args.userId, row.series_id, args.episodeId, amountCents);
    if (pending.status === "paid") return { ok: true, alreadyUnlocked: true };

    try {
        const clientSecret = await createIntentForUnlock({
            unlockId: pending.id,
            amountCents,
            seriesId: row.series_id,
            episodeId: args.episodeId,
            userId: args.userId,
            kindMetadata: {},
        });
        return { ok: true, alreadyUnlocked: false, clientSecret, amountCents };
    } catch (err) {
        logger.error({ err, episodeId: args.episodeId, userId: args.userId }, "[movies/unlock] failed to create Stripe intent");
        throw err;
    }
}

export async function createSeasonUnlockIntent(args: { userId: string; seriesId: string }): Promise<UnlockIntentResult> {
    const { rows } = await dbQuery<{
        id: string;
        owner_user_id: string;
        status: SeriesStatusValue;
        license_expires_at: string | null;
        free_episodes: number;
        episode_price_cents: string | number | null;
    }>(
        `SELECT id, owner_user_id, status, license_expires_at::text AS license_expires_at, free_episodes,
                episode_price_cents::text AS episode_price_cents
           FROM movie_series WHERE id = $1`,
        [args.seriesId],
    );
    const series = rows[0];
    if (!series) return { ok: false, reason: "not_found" };
    if (!isSeriesPublic(series)) return { ok: false, reason: "series_not_published" };

    const { rows: cnt } = await dbQuery<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM movie_episodes WHERE series_id = $1 AND status = 'published'`,
        [args.seriesId],
    );
    const priceCents = series.episode_price_cents === null ? null : Number(series.episode_price_cents);
    const amountCents = seasonPriceCents({ free_episodes: series.free_episodes, episode_price_cents: priceCents }, Number(cnt[0]?.count ?? 0));
    if (amountCents === null) return { ok: false, reason: "price_not_set" };
    if (amountCents === 0) return { ok: false, reason: "already_free" };

    const pending = await upsertPendingSeasonUnlock(args.userId, args.seriesId, amountCents);
    if (pending.status === "paid") return { ok: true, alreadyUnlocked: true };

    try {
        const clientSecret = await createIntentForUnlock({
            unlockId: pending.id,
            amountCents,
            seriesId: args.seriesId,
            episodeId: null,
            userId: args.userId,
            kindMetadata: {},
        });
        return { ok: true, alreadyUnlocked: false, clientSecret, amountCents };
    } catch (err) {
        logger.error({ err, seriesId: args.seriesId, userId: args.userId }, "[movies/unlock] failed to create Stripe intent");
        throw err;
    }
}

/**
 * Webhook `payment_intent.succeeded` (kind `movie_unlock`): marchează
 * deblocarea plătită (idempotent — no-op dacă rândul e deja `paid` sau
 * `payment_intent_id` nu se mai potrivește niciunui rând) și creditează cota
 * creatorului în cenți RON pe `lib/wallet/ledger.ts` (idempotent după
 * `refType`+`refId`=id-ul rândului de unlock).
 */
export async function markMovieUnlockPaid(args: {
    paymentIntentId: string;
    /** `metadata.unlockId` setat de server la crearea intentului. */
    unlockId: string | null;
    /** Suma efectiv încasată de Stripe (cenți) — sursa de adevăr pentru cota creatorului. */
    amountReceivedCents: number;
    currency: string;
}): Promise<void> {
    const { paymentIntentId, unlockId, amountReceivedCents, currency } = args;
    if (currency.toLowerCase() !== "ron" || !(amountReceivedCents > 0)) {
        logger.error({ paymentIntentId, currency, amountReceivedCents }, "[movies/unlock] unexpected paid amount/currency — unlock not granted");
        return;
    }
    // O singură procesare per PaymentIntent (cheie primară) — retry-urile Stripe sunt no-op.
    if (!(await claimUnlockPayment({ paymentIntentId, vertical: "movies", unlockId, amountCents: amountReceivedCents }))) return;
    type PaidRow = { id: string; user_id: string; series_id: string; episode_id: string | null; amount_cents: string | null; owner_user_id: string };
    // Plata, cota și creditarea creatorului într-O SINGURĂ tranzacție: dacă creditarea
    // eșuează, totul se anulează, rezultatul rămâne `processing` și retry-ul Stripe al
    // webhook-ului reia procesarea — cota creatorului nu se mai pierde în tăcere.
    const row = await withTransaction(async (q) => {
        const { rows } = await q<PaidRow>(
            `UPDATE movie_unlocks u
                SET status = 'paid', paid_at = now(), payment_intent_id = $1
               FROM movie_series s
              WHERE u.series_id = s.id AND u.status <> 'paid'
                AND (u.payment_intent_id = $1 OR u.id::text = $2)
              RETURNING u.id, u.user_id, u.series_id, u.episode_id, u.amount_cents::text AS amount_cents, s.owner_user_id`,
            [paymentIntentId, unlockId ?? ""],
        );
        const paid = rows[0];
        if (!paid) return null;
        if (Number(paid.amount_cents ?? 0) !== amountReceivedCents) {
            logger.warn({ unlockId: paid.id, stored: paid.amount_cents, received: amountReceivedCents }, "[movies/unlock] paid amount differs from stored price — using Stripe amount");
        }
        const share = creatorShareCents(amountReceivedCents, paid.owner_user_id, paid.user_id);
        await q(`UPDATE movie_unlocks SET amount_cents = $2, units_paid = $2, creator_share_units = $3 WHERE id = $1`, [paid.id, amountReceivedCents, share]);
        if (share > 0) {
            await creditUserTx(q, {
                userId: paid.owner_user_id,
                amountCents: share,
                refType: "movie_creator_share",
                refId: paid.id,
                description: "Swypik Movies — cotă creator",
                metadata: { seriesId: paid.series_id, episodeId: paid.episode_id },
            });
        }
        return paid;
    }).catch((err) => {
        logger.error({ err, paymentIntentId }, "[movies/unlock] grant + creator share failed — retried by the webhook");
        throw err;
    });
    if (!row) {
        const { rows: current } = await dbQuery<{ status: string; payment_intent_id: string | null }>(
            `SELECT status, payment_intent_id FROM movie_unlocks WHERE payment_intent_id = $1 OR id::text = $2 ORDER BY (status = 'paid') DESC LIMIT 1`,
            [paymentIntentId, unlockId ?? ""],
        );
        await settleUnmatchedUnlockPayment({ paymentIntentId, vertical: "movies", unlockId, current: current[0] ?? null });
        return;
    }
    await recordUnlockPaymentOutcome(paymentIntentId, "granted");
}

/**
 * Refund total sau dispută pierdută pentru o deblocare plătită cu cardul:
 * accesul se revocă (status `refunded`) și cota creatorului se retrage din
 * portofelul RON (poate duce soldul pe minus; idempotent pe id-ul deblocării).
 * Întoarce true dacă plata aparținea unei deblocări Movies.
 */
export async function revokeMovieUnlockForPayment(paymentIntentId: string, reason: string): Promise<boolean> {
    const { rows } = await dbQuery<{ id: string; owner_id: string; share: string | null }>(
        `UPDATE movie_unlocks u
            SET status = 'refunded'
           FROM movie_series s
          WHERE u.series_id = s.id AND u.payment_intent_id = $1 AND u.status = 'paid'
          RETURNING u.id, s.owner_user_id AS owner_id, u.creator_share_units::text AS share`,
        [paymentIntentId],
    );
    const row = rows[0];
    if (!row) {
        const known = await dbQuery(`SELECT 1 FROM movie_unlocks WHERE payment_intent_id = $1 LIMIT 1`, [paymentIntentId]);
        return known.rows.length > 0;
    }
    const share = Number(row.share ?? 0);
    if (share > 0) {
        await debitUser({
            userId: row.owner_id,
            amountCents: share,
            refType: "movie_creator_share_reversal",
            refId: row.id,
            description: "Swypik Movies — cotă creator retrasă (refund/dispută)",
            metadata: { paymentIntentId, reason },
            allowNegative: true,
        }).catch((err) => logger.error({ err, unlockId: row.id }, "[movies/unlock] share reversal failed"));
    }
    logger.info({ unlockId: row.id, paymentIntentId, reason }, "[movies/unlock] unlock revoked");
    return true;
}
