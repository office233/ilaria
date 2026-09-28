import type Stripe from "stripe";
import { logger } from "@/lib/logger";
import { markMovieUnlockPaid, revokeMovieUnlockForPayment } from "@/lib/movies/unlock";
import { markMusicUnlockPaid, revokeMusicUnlockForPayment } from "@/lib/music/unlock";
import { isKnownUnlockPayment } from "@/lib/media/unlock-payments";

/** `metadata.kind` values that this handler owns (routed from `route.ts`). */
export const CREATOR_UNLOCK_KINDS = new Set(["movie_unlock", "music_track_unlock", "music_album_unlock"]);

/**
 * `payment_intent.succeeded` pentru deblocările Movies/Music (card, RON).
 * Idempotent pe `payment_intent.id` — `markMovieUnlockPaid`/`markMusicUnlockPaid`
 * fac UPDATE ... WHERE status <> 'paid' și ies fără efect dacă rândul e deja plătit.
 */
export async function handleCreatorUnlockPaymentSucceeded(event: Stripe.Event): Promise<void> {
    const intent = event.data.object as Stripe.PaymentIntent;
    const kind = intent.metadata?.kind;
    logger.info({ intentId: intent.id, kind }, "[Stripe Webhook] creator unlock payment succeeded");
    const paid = {
        paymentIntentId: intent.id,
        unlockId: intent.metadata?.unlockId || null,
        amountReceivedCents: intent.amount_received ?? intent.amount ?? 0,
        currency: intent.currency ?? "",
    };
    if (kind === "movie_unlock") {
        await markMovieUnlockPaid(paid);
        return;
    }
    if (kind === "music_track_unlock" || kind === "music_album_unlock") {
        await markMusicUnlockPaid(paid);
        return;
    }
    logger.warn({ intentId: intent.id, kind }, "[Stripe Webhook] creator unlock handler invoked with unknown kind");
}

/**
 * Refund total / dispută pierdută: dacă plata aparține unei deblocări Movies
 * sau Music, revocă accesul și retrage cota creatorului. Întoarce true dacă
 * plata a fost a unei deblocări (restul handler-ului de comenzi nu mai e relevant).
 */
export async function revokeCreatorUnlockForPayment(paymentIntentId: string, reason: string): Promise<boolean> {
    const movie = await revokeMovieUnlockForPayment(paymentIntentId, reason);
    if (movie) return true;
    if (await revokeMusicUnlockForPayment(paymentIntentId, reason)) return true;
    // Rambursarea automată a unei plăți duplicate: aparține deblocărilor, nu comenzilor.
    return isKnownUnlockPayment(paymentIntentId);
}
