/**
 * Recenzii după sejur: doar clientul rezervării, după check-out, o dată, în
 * fereastra STAYS_REVIEW_WINDOW_DAYS. Nota medie apare în căutare și pe pagina
 * cazării.
 */
import { dbQuery } from "@/lib/db";
import type { Q } from "./booking";
import { loadBooking } from "./bookings-repo";
import { staysConfig } from "./config";
import { todayIso } from "./dates";
import { StaysError } from "./errors";
import { canReview } from "./policy";

const db: Q = (text, params) => dbQuery(text, params ?? []);

export type StayReview = {
    id: string;
    rating: number;
    comment: string | null;
    host_reply: string | null;
    created_at: string;
    author: string | null;
};

export async function createReview(
    bookingId: string,
    userId: string,
    rating: number,
    comment: string | null,
    now: Date = new Date(),
): Promise<string> {
    const b = await loadBooking(db, bookingId);
    if (!b || b.guest_user_id !== userId) throw new StaysError("not_found");
    if (!canReview({ status: b.status, checkOut: b.check_out, today: todayIso(now), windowDays: staysConfig.reviewWindowDays() })) {
        throw new StaysError("review_not_allowed");
    }
    const { rows } = await dbQuery<{ id: string }>(
        `INSERT INTO stay_reviews (booking_id, product_id, guest_user_id, host_user_id, rating, comment)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)
         ON CONFLICT (booking_id) DO NOTHING
         RETURNING id::text`,
        [b.id, b.product_id, userId, b.host_user_id, rating, comment],
    );
    if (!rows[0]) throw new StaysError("already_reviewed");
    return rows[0].id;
}

/** Recenzia existentă pentru o rezervare (pentru pagina de detaliu a clientului). */
export async function reviewForBooking(bookingId: string): Promise<{ rating: number; comment: string | null } | null> {
    const { rows } = await dbQuery<{ rating: number; comment: string | null }>(
        `SELECT rating, comment FROM stay_reviews WHERE booking_id = $1::uuid`,
        [bookingId],
    );
    return rows[0] ?? null;
}

export async function listReviews(productId: string, limit = 20): Promise<{ reviews: StayReview[]; average: number | null; count: number }> {
    const [list, agg] = await Promise.all([
        dbQuery<StayReview>(
            `SELECT r.id::text, r.rating, r.comment, r.host_reply, r.created_at::text,
                    COALESCE(u.display_name, split_part(b.guest_name, ' ', 1)) AS author
               FROM stay_reviews r
               JOIN stay_bookings b ON b.id = r.booking_id
               LEFT JOIN users u ON u.id = r.guest_user_id
              WHERE r.product_id = $1::uuid AND r.status = 'published'
              ORDER BY r.created_at DESC LIMIT $2`,
            [productId, limit],
        ),
        dbQuery<{ avg: string | null; n: number }>(
            `SELECT round(avg(rating)::numeric, 1)::text AS avg, COUNT(*)::int AS n
               FROM stay_reviews WHERE product_id = $1::uuid AND status = 'published'`,
            [productId],
        ),
    ]);
    const a = agg.rows[0];
    return { reviews: list.rows, average: a?.avg ? Number(a.avg) : null, count: a?.n ?? 0 };
}
