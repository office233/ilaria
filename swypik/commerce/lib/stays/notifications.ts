/**
 * Notificări Swypik Stays (push + email), în limba destinatarului
 * (users.locale, fallback ro). Textele: namespace-ul `staysNotify`.
 * Toate sunt best-effort: o eroare de notificare NU afectează rezervarea.
 */
import { createTranslator } from "next-intl";
import { dbQuery } from "@/lib/db";
import { sendPushToUser } from "@/lib/push/send";
import { sendEmail } from "@/lib/email/service";
import { logger } from "@/lib/logger";
import { APP_URL } from "@/lib/app-url";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/config";

type Info = {
    id: string;
    title: string;
    check_in: string;
    check_out: string;
    guests_count: number;
    total_cents: number;
    currency: string;
    refund_cents: number;
    guest_user_id: string | null;
    guest_name: string;
    guest_email: string | null;
    host_user_id: string | null;
    host_email: string | null;
};

type Event = "hostRequest" | "guestConfirmed" | "guestDeclined" | "guestExpired" | "guestCancelled" | "hostCancelled" | "hostGuestCancelled";

function escapeHtml(v: unknown): string {
    return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

async function loadInfo(bookingId: string): Promise<Info | null> {
    const { rows } = await dbQuery<Info>(
        `SELECT b.id::text, p.title, b.check_in::text, b.check_out::text, b.guests_count, b.total_cents,
                b.currency, b.refund_cents, b.guest_user_id::text, b.guest_name, b.guest_email,
                COALESCE(b.host_user_id::text, p.metadata->>'host_user_id') AS host_user_id,
                hu.email AS host_email
           FROM stay_bookings b
           JOIN marketplace_products p ON p.id = b.product_id
           LEFT JOIN users hu ON hu.id::text = COALESCE(b.host_user_id::text, p.metadata->>'host_user_id')
          WHERE b.id = $1::uuid`,
        [bookingId],
    );
    return rows[0] ?? null;
}

async function localeOf(userId: string | null): Promise<Locale> {
    if (!userId) return DEFAULT_LOCALE;
    const { rows } = await dbQuery<{ locale: string | null }>(`SELECT locale FROM users WHERE id = $1::uuid`, [userId]).catch(
        () => ({ rows: [] as { locale: string | null }[] }),
    );
    return isLocale(rows[0]?.locale) ? (rows[0]!.locale as Locale) : DEFAULT_LOCALE;
}

async function send(event: Event, to: { userId: string | null; email: string | null }, b: Info, path: string): Promise<void> {
    const locale = await localeOf(to.userId);
    const messages = (await import(`../../messages/${locale}.json`)).default;
    const t = createTranslator({ locale, messages, namespace: "staysNotify" });
    const date = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(locale, { day: "numeric", month: "long", timeZone: "UTC" });
    const money = (c: number) => new Intl.NumberFormat(locale, { style: "currency", currency: b.currency || "RON" }).format(c / 100);
    const vars = {
        title: b.title,
        period: `${date(b.check_in)} – ${date(b.check_out)}`,
        guests: b.guests_count,
        guest: b.guest_name,
        total: money(b.total_cents),
        refund: money(b.refund_cents),
    };
    const title = t(`${event}.title`, vars);
    const body = t(`${event}.body`, vars);
    if (to.userId) {
        await sendPushToUser(to.userId, { title, body, url: path, tag: `stay-${event}-${b.id}` }).catch((err) =>
            logger.warn({ err, bookingId: b.id, event }, "stays: push failed"),
        );
    }
    if (to.email) {
        const href = `${APP_URL}${path}`;
        await sendEmail({
            to: to.email,
            subject: t(`${event}.title`, vars),
            html: `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>
                   <p><a href="${escapeHtml(href)}">${escapeHtml(t("cta"))}</a></p>`,
        }).catch((err) => logger.warn({ err, bookingId: b.id, event }, "stays: email failed"));
    }
}

async function notify(bookingId: string, fn: (b: Info) => Promise<void>): Promise<void> {
    try {
        const b = await loadInfo(bookingId);
        if (b) await fn(b);
    } catch (err) {
        logger.error({ err, bookingId }, "stays: notification failed");
    }
}

const guestPath = (b: Info) => `/account/stays/${b.id}`;
const HOST_PATH = "/stays/manage";

/** Gazda: cerere nouă, plătită (hold) — trebuie acceptată sau refuzată. */
export function notifyHostNewRequest(bookingId: string): Promise<void> {
    return notify(bookingId, (b) => send("hostRequest", { userId: b.host_user_id, email: b.host_email }, b, HOST_PATH));
}

export function notifyGuestBookingConfirmed(bookingId: string): Promise<void> {
    return notify(bookingId, (b) => send("guestConfirmed", { userId: b.guest_user_id, email: b.guest_email }, b, guestPath(b)));
}

export function notifyGuestDeclined(bookingId: string, why: "declined" | "expired"): Promise<void> {
    const event: Event = why === "declined" ? "guestDeclined" : "guestExpired";
    return notify(bookingId, (b) => send(event, { userId: b.guest_user_id, email: b.guest_email }, b, guestPath(b)));
}

/** La anulare: partea care NU a anulat e anunțată; clientul primește mereu detaliile de refund. */
export function notifyCancellation(bookingId: string, by: "guest" | "host"): Promise<void> {
    return notify(bookingId, async (b) => {
        await send(by === "host" ? "hostCancelled" : "guestCancelled", { userId: b.guest_user_id, email: b.guest_email }, b, guestPath(b));
        if (by === "guest") {
            await send("hostGuestCancelled", { userId: b.host_user_id, email: b.host_email }, b, HOST_PATH);
        }
    });
}
