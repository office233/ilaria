/**
 * Stripe Checkout pentru bilete de avion — sesiune dedicată (nu trece prin
 * fluxul de comenzi commerce). metadata.fly_booking_id leagă sesiunea de
 * flight_bookings; webhook-ul apelează fulfillFlightBooking().
 */
import { getStripe } from "@/lib/stripe/checkout";
import { FlightOffer } from "./types";
import { APP_URL } from "@/lib/app-url";

export async function createFlightCheckoutSession(
    bookingId: string,
    offer: FlightOffer,
    customerEmail?: string,
): Promise<{ url: string; sessionId: string }> {
    const stripe = getStripe();
    const baseUrl = APP_URL;
    const route = `${offer.slices[0]?.origin} → ${offer.slices[0]?.destination}`;

    const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
            {
                price_data: {
                    currency: offer.currency.toLowerCase(),
                    product_data: {
                        name: `Bilet avion ${route}`,
                        metadata: { fly_booking_id: bookingId },
                    },
                    unit_amount: offer.totalCents,
                },
                quantity: 1,
            },
        ],
        metadata: { fly_booking_id: bookingId },
        customer_email: customerEmail || undefined,
        success_url: `${baseUrl}/fly/bookings/${bookingId}?paid=1`,
        cancel_url: `${baseUrl}/fly?cancelled=1`,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });

    if (!session.url) throw new Error("Stripe session has no URL");
    return { url: session.url, sessionId: session.id };
}
