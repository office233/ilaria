import { notFound } from "next/navigation";
import { redirect } from "@/lib/i18n/navigation";
import { isFlyBookingEnabled } from "@/lib/fly/gate";
import { dbQuery } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; locale: string }> };

const STATUS_KEYS = new Set(["pending", "paid", "ticketed", "failed", "cancelled"]);

type FlightBookingRow = {
    id: string;
    status: string;
    origin: string;
    destination: string;
    depart_date: string;
    return_date: string | null;
    booking_ref: string | null;
    provider: string;
    total_cents: number;
    currency: string;
};

export default async function FlyBookingPage({ params }: Params) {
    // Rezervările Fly sunt închise până există un furnizor (FEATURE_FLY_BOOKING).
    if (!isFlyBookingEnabled()) notFound();
    const { id, locale } = await params;
    const t = await getTranslations("flyBooking");
    const user = await getAuthUser();
    if (!user.userId) return redirect({ href: `/account?redirect=/fly/bookings/${id}`, locale });

    const { rows } = await dbQuery<FlightBookingRow>(
        `SELECT id::text, status, origin, destination, depart_date::text AS depart_date,
            return_date::text AS return_date, booking_ref, provider,
            total_cents::int8 AS total_cents, currency
       FROM flight_bookings WHERE id = $1 AND user_id = $2`,
        [id, user.userId],
    );
    const b = rows[0];
    if (!b) return redirect({ href: "/fly", locale });

    const total = new Intl.NumberFormat(locale, { style: "currency", currency: b.currency }).format(
        Number(b.total_cents) / 100,
    );

    return (
        <div className="mx-auto max-w-lg px-4 pb-24 pt-8">
            <h1 className="text-xl font-bold">
                {b.origin} → {b.destination}
            </h1>
            <p className="mt-1 text-sm text-neutral-500">
                {b.depart_date}
                {b.return_date ? ` · ${t("return")} ${b.return_date}` : ""}
            </p>

            <div className="mt-5 rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <div className="flex items-center justify-between">
                    <span className="text-sm text-neutral-500">{t("status")}</span>
                    <span className="font-semibold">{STATUS_KEYS.has(b.status) ? t(`statusLabel.${b.status}`) : b.status}</span>
                </div>
                {b.booking_ref && (
                    <div className="mt-2 flex items-center justify-between">
                        <span className="text-sm text-neutral-500">{t("pnr")}</span>
                        <span className="font-mono font-bold">{b.booking_ref}</span>
                    </div>
                )}
                <div className="mt-2 flex items-center justify-between">
                    <span className="text-sm text-neutral-500">{t("total")}</span>
                    <span className="text-lg font-extrabold">{total}</span>
                </div>
            </div>

            {b.status === "ticketed" && (
                <a
                    href="/explore"
                    className="mt-4 block rounded-2xl bg-gradient-to-r from-orange-500 to-red-500 p-4 text-white shadow"
                >
                    <p className="font-bold">{t("foodPromoTitle")}</p>
                    <p className="text-sm opacity-90">{t("foodPromoSubtitle")}</p>
                </a>
            )}
        </div>
    );
}
