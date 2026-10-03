"use client";

/**
 * Cererile și rezervările gazdei. Cererile 'requested' (plată ținută) au
 * Acceptă / Refuză; rezervările confirmate viitoare pot fi anulate (refund
 * integral clientului). Confirmările folosesc Dialog, nu confirm() nativ.
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarX2, Mail, Phone } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Textarea } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { BookingStatusBadge } from "@/components/stays/BookingStatusBadge";
import { errorKey, useStaysFormat } from "@/components/stays/format";
import type { BookingRow } from "@/lib/stays/bookings-repo";
import { todayIso } from "@/lib/stays/dates";

type Row = Omit<BookingRow, "stripe_payment_intent_id">;
type Pending = { kind: "decline" | "cancel"; booking: Row } | null;

export default function HostBookings() {
    const t = useTranslations("staysHost");
    const tu = useTranslations("staysUi");
    const f = useStaysFormat();
    const { toast } = useToast();
    const [rows, setRows] = useState<Row[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [pending, setPending] = useState<Pending>(null);
    const [reason, setReason] = useState("");

    const load = useCallback(async () => {
        setFailed(false);
        try {
            const res = await fetch("/api/host/bookings");
            if (!res.ok) throw new Error();
            setRows(((await res.json()) as { bookings: Row[] }).bookings);
        } catch {
            setFailed(true);
        }
    }, []);
    useEffect(() => {
        void load();
    }, [load]);

    const act = async (id: string, url: string, body: unknown, ok: string) => {
        setBusy(id);
        try {
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            if (!res.ok) throw new Error(j.error ?? "internal_error");
            toast({ title: ok, tone: "success" });
            setPending(null);
            setReason("");
            await load();
        } catch (e) {
            toast({ title: tu(errorKey((e as Error).message)), tone: "danger" });
        } finally {
            setBusy(null);
        }
    };

    if (failed) return <ErrorState onRetry={() => void load()} />;
    if (!rows) return <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-36 w-full rounded-card" />)}</div>;
    if (!rows.length) return <EmptyState icon={CalendarX2} title={t("noBookingsTitle")} description={t("noBookingsBody")} />;

    const today = todayIso();
    return (
        <>
            <ul className="space-y-3">
                {rows.map((b) => (
                    <li key={b.id}>
                        <Card padding="md" className="space-y-2">
                            <div className="flex items-start justify-between gap-2">
                                <p className="min-w-0 truncate text-sm font-semibold text-fg">{b.title}</p>
                                <BookingStatusBadge status={b.status} />
                            </div>
                            <p className="text-sm text-fg">
                                {f.date(b.check_in)} – {f.date(b.check_out)} · {tu("guestsCount", { count: b.guests_count })} ·{" "}
                                <span className="font-semibold">{f.money(b.total_cents, b.currency)}</span>
                            </p>
                            <p className="text-sm text-muted">{b.guest_name}</p>
                            <div className="flex flex-wrap gap-2">
                                {b.guest_phone ? (
                                    <Button asChild size="sm" variant="ghost"><a href={`tel:${b.guest_phone}`}><Phone className="h-4 w-4" aria-hidden />{b.guest_phone}</a></Button>
                                ) : null}
                                {b.guest_email ? (
                                    <Button asChild size="sm" variant="ghost"><a href={`mailto:${b.guest_email}`}><Mail className="h-4 w-4" aria-hidden />{t("emailGuest")}</a></Button>
                                ) : null}
                            </div>
                            {b.status === "requested" ? (
                                <>
                                    {b.expires_at ? <p className="text-xs text-warning">{t("respondBy", { date: f.dateTime(b.expires_at) })}</p> : null}
                                    <div className="flex gap-2">
                                        <Button variant="secondary" className="flex-1" disabled={busy === b.id} onClick={() => setPending({ kind: "decline", booking: b })}>{t("decline")}</Button>
                                        <Button className="flex-1" loading={busy === b.id} onClick={() => void act(b.id, `/api/host/bookings/${b.id}/accept`, {}, t("acceptedToast"))}>{t("accept")}</Button>
                                    </div>
                                </>
                            ) : b.status === "confirmed" && b.check_in >= today ? (
                                <Button variant="ghost" size="sm" onClick={() => setPending({ kind: "cancel", booking: b })}>{t("cancelBooking")}</Button>
                            ) : null}
                        </Card>
                    </li>
                ))}
            </ul>
            <Dialog
                open={pending !== null}
                onOpenChange={(o) => !o && setPending(null)}
                title={pending?.kind === "decline" ? t("declineTitle") : t("cancelTitle")}
                description={pending?.kind === "decline" ? t("declineBody") : t("cancelBody", { amount: pending ? f.money(pending.booking.total_cents, pending.booking.currency) : "" })}
                footer={
                    <div className="flex gap-2">
                        <Button variant="secondary" className="flex-1" onClick={() => setPending(null)}>{t("back")}</Button>
                        <Button
                            variant="danger"
                            className="flex-1"
                            loading={busy === pending?.booking.id}
                            onClick={() =>
                                pending &&
                                void (pending.kind === "decline"
                                    ? act(pending.booking.id, `/api/host/bookings/${pending.booking.id}/decline`, { reason: reason || undefined }, t("declinedToast"))
                                    : act(pending.booking.id, `/api/stays/bookings/${pending.booking.id}/cancel`, {}, t("cancelledToast")))
                            }
                        >
                            {pending?.kind === "decline" ? t("decline") : t("confirmCancel")}
                        </Button>
                    </div>
                }
            >
                {pending?.kind === "decline" ? (
                    <Textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={t("declineReasonPlaceholder")} aria-label={t("declineReasonPlaceholder")} />
                ) : null}
            </Dialog>
        </>
    );
}
