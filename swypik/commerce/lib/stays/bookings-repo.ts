/**
 * Citirea rezervărilor Stays (un singur SELECT, folosit de plăți, decizii
 * gazdă, anulări, recenzii și paginile de detaliu).
 */
import { dbQuery } from "@/lib/db";
import type { Q } from "./booking";

export type BookingRow = {
    id: string;
    product_id: string;
    guest_user_id: string | null;
    host_user_id: string | null;
    guest_name: string;
    guest_email: string | null;
    guest_phone: string | null;
    check_in: string;
    check_out: string;
    guests_count: number;
    total_cents: number;
    currency: string;
    status: string;
    payment_status: string;
    payment_method: "card" | "wallet" | null;
    stripe_payment_intent_id: string | null;
    expires_at: string | null;
    refund_cents: number;
    decline_reason: string | null;
    cancelled_by: string | null;
    created_at: string;
    title: string;
    image_url: string | null;
    location_city: string | null;
};

const COLS = `b.id::text, b.product_id::text, b.guest_user_id::text,
  COALESCE(b.host_user_id::text, p.metadata->>'host_user_id') AS host_user_id,
  b.guest_name, b.guest_email, b.guest_phone, b.check_in::text, b.check_out::text,
  b.guests_count, b.total_cents, b.currency, b.status, b.payment_status, b.payment_method,
  b.stripe_payment_intent_id, b.expires_at::text, b.refund_cents, b.decline_reason,
  b.cancelled_by, b.created_at::text, p.title, p.image_url, p.location_city`;

/** O rezervare (opțional blocată FOR UPDATE în tranzacția `q`). */
export async function loadBooking(q: Q, bookingId: string, forUpdate = false): Promise<BookingRow | null> {
    const { rows } = await q<BookingRow>(
        `SELECT ${COLS}
           FROM stay_bookings b
           JOIN marketplace_products p ON p.id = b.product_id
          WHERE b.id = $1::uuid${forUpdate ? " FOR UPDATE OF b" : ""}`,
        [bookingId],
    );
    return rows[0] ?? null;
}

export async function listGuestBookings(userId: string, limit = 50): Promise<BookingRow[]> {
    const { rows } = await dbQuery<BookingRow>(
        `SELECT ${COLS}
           FROM stay_bookings b
           JOIN marketplace_products p ON p.id = b.product_id
          WHERE b.guest_user_id = $1::uuid AND b.status <> 'expired'
          ORDER BY b.check_in DESC, b.created_at DESC
          LIMIT $2`,
        [userId, limit],
    );
    return rows;
}

/** Rezervările primite de gazdă; cererile de aprobat primele. */
export async function listHostBookings(hostUserId: string, limit = 100): Promise<BookingRow[]> {
    const { rows } = await dbQuery<BookingRow>(
        `SELECT ${COLS}
           FROM stay_bookings b
           JOIN marketplace_products p ON p.id = b.product_id
          WHERE COALESCE(b.host_user_id::text, p.metadata->>'host_user_id') = $1
            AND b.status NOT IN ('pending','expired')
          ORDER BY (b.status = 'requested') DESC, b.check_in DESC
          LIMIT $2`,
        [hostUserId, limit],
    );
    return rows;
}

/** Cine e utilizatorul față de rezervare. */
export function relationTo(b: BookingRow, userId: string): "guest" | "host" | null {
    if (b.guest_user_id === userId) return "guest";
    if (b.host_user_id === userId) return "host";
    return null;
}
