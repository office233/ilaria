"use client";

/**
 * Rezervarea în 3 pași, într-un sheet de jos:
 *   1. detalii — interval (nopțile ocupate tăiate), oaspeți, contact, preț
 *   2. plată — card (hold, principal) sau wallet (secundar)
 *   3. gata — cererea a ajuns la gazdă; cardul se debitează doar la accept
 */
import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Input";
import { Sheet } from "@/components/ui/Sheet";
import { Link } from "@/lib/i18n/navigation";
import { occupiedNights, todayIso } from "@/lib/stays/dates";
import type { Range } from "@/lib/stays/range-select";
import { DateRangeField } from "./DateRangeField";
import { errorKey, useStaysFormat } from "./format";
import { GuestStepper } from "./GuestStepper";
import { PaymentStep } from "./PaymentStep";
import { useStayQuote } from "./useStayQuote";

type Props = {
    open: boolean;
    onOpenChange: (o: boolean) => void;
    stayId: string;
    initial: { range: Range; guests: number };
    limits: { maxNights: number; maxGuests: number; hostResponseHours: number };
};
type Booking = { bookingId: string; totalCents: number; currency: string };
type Step = "details" | "pay" | "done";

export function StayBookingSheet({ open, onOpenChange, stayId, initial, limits }: Props) {
    const t = useTranslations("staysUi");
    const f = useStaysFormat();
    const [range, setRange] = useState<Range>(initial.range);
    const [guests, setGuests] = useState(initial.guests);
    const [contact, setContact] = useState({ name: "", email: "", phone: "" });
    const [occupied, setOccupied] = useState<ReadonlySet<string>>(new Set());
    const [step, setStep] = useState<Step>("details");
    const [booking, setBooking] = useState<Booking | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const quote = useStayQuote(stayId, range, guests);

    useEffect(() => {
        if (!open) return;
        fetch(`/api/stays/bookings?product_id=${stayId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((j: { booked: { check_in: string; check_out: string }[]; blockedDays: string[] } | null) => {
                if (!j) return;
                const s = occupiedNights(j.booked);
                j.blockedDays.forEach((d) => s.add(d));
                setOccupied(s);
            })
            .catch(() => undefined);
    }, [open, stayId]);

    const post = async (url: string, body?: unknown) => {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) throw new Error(String(j.error ?? "internal_error"));
        return j;
    };

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const reserve = () =>
        run(async () => {
            const j = await post("/api/stays/bookings", {
                product_id: stayId,
                check_in: range.checkIn,
                check_out: range.checkOut,
                guests_count: guests,
                guest_name: contact.name,
                guest_email: contact.email || undefined,
                guest_phone: contact.phone || undefined,
            });
            setBooking(j.booking as Booking);
            setStep("pay");
        });

    const canReserve = quote.data?.available && contact.name.trim().length >= 2 && Boolean(contact.email || contact.phone);
    const errorText = error === "unauthorized" ? t("loginRequired") : error ? t(errorKey(error)) : null;

    return (
        <Sheet open={open} onOpenChange={onOpenChange} title={step === "done" ? t("requestSentTitle") : t("bookTitle")}>
            {step === "details" ? (
                <div className="space-y-3">
                    <DateRangeField value={range} onChange={setRange} minDate={todayIso()} maxNights={limits.maxNights} occupied={occupied} />
                    <GuestStepper value={guests} max={limits.maxGuests} onChange={setGuests} />
                    {quote.data ? (
                        <div className="rounded-control bg-surface-2 p-3 text-sm" aria-live="polite">
                            {quote.data.available ? (
                                <p className="flex justify-between font-semibold text-fg">
                                    <span>{t("totalFor", { count: quote.data.nights })}</span>
                                    <span>{f.money(quote.data.totalCents, quote.data.currency)}</span>
                                </p>
                            ) : (
                                <p className="text-danger">{t(errorKey(quote.data.reason))}</p>
                            )}
                        </div>
                    ) : null}
                    <TextField label={t("nameLabel")} autoComplete="name" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
                    <TextField label={t("emailLabel")} type="email" inputMode="email" autoComplete="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
                    <TextField label={t("phoneLabel")} type="tel" inputMode="tel" autoComplete="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} hint={t("contactHint")} />
                    {errorText ? <p role="alert" className="text-sm font-medium text-danger">{errorText}</p> : null}
                    {error === "unauthorized" ? (
                        <Button asChild block variant="secondary"><Link href={`/account?redirect=/stays/${stayId}`}>{t("loginButton")}</Link></Button>
                    ) : null}
                    <Button block size="lg" loading={busy} disabled={!canReserve} onClick={reserve}>{t("requestToBook")}</Button>
                    <p className="text-center text-xs text-muted">{t("requestExplainer", { hours: limits.hostResponseHours })}</p>
                </div>
            ) : step === "pay" && booking ? (
                <PaymentStep bookingId={booking.bookingId} totalCents={booking.totalCents} currency={booking.currency} onDone={() => setStep("done")} />
            ) : (
                <div className="space-y-4 py-4 text-center">
                    <CheckCircle2 className="mx-auto h-12 w-12 text-success" aria-hidden />
                    <p className="text-sm text-muted">{t("requestSentBody", { hours: limits.hostResponseHours })}</p>
                    {booking ? <Button asChild block><Link href={`/account/stays/${booking.bookingId}`}>{t("viewBooking")}</Link></Button> : null}
                </div>
            )}
        </Sheet>
    );
}
