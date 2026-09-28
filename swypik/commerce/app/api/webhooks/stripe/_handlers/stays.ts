import type Stripe from "stripe";
import { markStayBookingAuthorized } from "@/lib/stays/stripe-payment";
import { confirmCardAndDispatch } from "@/lib/rides/dispatch-start";
import { logger } from "@/lib/logger";

/**
 * `payment_intent.amount_capturable_updated` — hold autorizat pe card
 * (capture_method=manual). Stays: cererea ajunge la gazdă. Go: plasa de
 * siguranță pentru confirmarea din client — verifică hold-ul și pornește
 * dispatch-ul (idempotent).
 */
export async function handlePaymentIntentCapturable(event: Stripe.Event): Promise<void> {
    const intent = event.data.object as Stripe.PaymentIntent;
    if (intent.metadata?.kind === "stay_booking" && intent.metadata?.stay_booking_id) {
        await markStayBookingAuthorized(intent.metadata.stay_booking_id);
    } else if (intent.metadata?.kind === "ride" && intent.metadata?.ride_id) {
        try {
            await confirmCardAndDispatch(intent.metadata.ride_id);
        } catch (err) {
            logger.warn({ err, rideId: intent.metadata.ride_id }, "[webhook] ride authorization sync skipped");
        }
    }
}
