import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { redirect } from "@/lib/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { BookingStatusBadge } from "@/components/stays/BookingStatusBadge";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { Link } from "@/lib/i18n/navigation";
import type { Q } from "@/lib/stays/booking";
import { loadBooking } from "@/lib/stays/bookings-repo";
import { previewGuestRefund } from "@/lib/stays/cancellation";
import { staysConfig } from "@/lib/stays/config";
import { nightsCount, todayIso } from "@/lib/stays/dates";
import { canReview, guestCanCancel } from "@/lib/stays/policy";
import { reviewForBooking } from "@/lib/stays/reviews";
import { UUID_RE } from "@/lib/stays/route";
import GuestBookingActions from "./GuestBookingActions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; locale: string }> };
const db: Q = (text, params) => dbQuery(text, params ?? []);

export async function generateMetadata({ params }: Params): Promise<Metadata> {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "staysUi" });
    return { title: t("bookingTitle") };
}

export default async function GuestBookingPage({ params }: Params) {
    const { id, locale } = await params;
    if (!UUID_RE.test(id)) notFound();
    const user = await getAuthUser();
    if (!user.userId) return redirect({ href: `/account?redirect=/account/stays/${id}`, locale });
    const b = await loadBooking(db, id);
    if (!b || b.guest_user_id !== user.userId) notFound();

    const t = await getTranslations({ locale, namespace: "staysUi" });
    const today = todayIso();
    const review = await reviewForBooking(b.id);
    const money = (c: number) => new Intl.NumberFormat(locale, { style: "currency", currency: b.currency || "RON" }).format(c / 100);
    const date = (iso: string) =>
        new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
    const pendingOpen = b.status === "pending" && (!b.expires_at || Date.parse(b.expires_at) > Date.now());

    return (
        <div className="min-h-dvh bg-canvas">
            <PageHeader back="/account/stays" title={t("bookingTitle")} />
            <main className="mx-auto max-w-lg space-y-4 px-gutter py-4">
                <Card padding="md" className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                        <Link href={`/stays/${b.product_id}`} className="min-w-0 text-base font-semibold text-fg underline-offset-4 hover:underline">
                            {b.title}
                        </Link>
                        <BookingStatusBadge status={b.status} />
                    </div>
                    <dl className="grid grid-cols-2 gap-3 text-sm">
                        <div>
                            <dt className="text-muted">{t("checkInLabel")}</dt>
                            <dd className="font-medium text-fg">{date(b.check_in)}</dd>
                        </div>
                        <div>
                            <dt className="text-muted">{t("checkOutLabel")}</dt>
                            <dd className="font-medium text-fg">{date(b.check_out)}</dd>
                        </div>
                        <div>
                            <dt className="text-muted">{t("guestsLabel")}</dt>
                            <dd className="font-medium text-fg">{t("guestsCount", { count: b.guests_count })}</dd>
                        </div>
                        <div>
                            <dt className="text-muted">{t("totalFor", { count: nightsCount(b.check_in, b.check_out) })}</dt>
                            <dd className="font-medium text-fg">{money(b.total_cents)}</dd>
                        </div>
                    </dl>
                    <p className="text-sm text-muted">{t(`statusHelp.${b.status}`, { refund: money(b.refund_cents) })}</p>
                    {b.decline_reason ? <p className="text-sm text-muted">{t("declineReason", { reason: b.decline_reason })}</p> : null}
                </Card>

                <GuestBookingActions
                    booking={{ id: b.id, totalCents: b.total_cents, currency: b.currency }}
                    canPay={pendingOpen}
                    canCancel={guestCanCancel(b.status, b.check_in, today)}
                    refundPreview={previewGuestRefund(b)}
                    canReview={!review && canReview({ status: b.status, checkOut: b.check_out, today, windowDays: staysConfig.reviewWindowDays() })}
                    existingReview={review}
                />
            </main>
        </div>
    );
}
