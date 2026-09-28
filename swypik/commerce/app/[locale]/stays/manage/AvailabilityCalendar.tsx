"use client";

/**
 * Calendarul gazdei: alegi listarea, atingi zilele (celule de 44px), apoi
 * blochezi / deblochezi sau setezi un preț special. Nopțile rezervate sunt
 * doar pentru citire.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { errorKey } from "@/components/stays/format";
import { addDays, occupiedNights, todayIso } from "@/lib/stays/dates";
import type { HostListing } from "@/lib/stays/listings";
import { monthGrid } from "@/lib/stays/range-select";
import { cn } from "@/lib/ui/cn";
import type { HostLimits } from "./HostPanelClient";

type Data = { blocked: Set<string>; priced: Map<string, number>; booked: Set<string> };
const EMPTY: Data = { blocked: new Set(), priced: new Map(), booked: new Set() };

export default function AvailabilityCalendar({ listings, limits }: { listings: HostListing[]; limits: HostLimits }) {
    const t = useTranslations("staysHost");
    const tu = useTranslations("staysUi");
    const locale = useLocale();
    const { toast } = useToast();
    const today = todayIso();
    const [listingId, setListingId] = useState(listings[0]?.id ?? "");
    const [cursor, setCursor] = useState({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 });
    const [data, setData] = useState<Data>(EMPTY);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [price, setPrice] = useState("");
    const [busy, setBusy] = useState(false);
    const { offset, days } = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor]);

    const load = useCallback(async () => {
        if (!listingId) return;
        const from = days[0];
        const to = addDays(days[days.length - 1], 1);
        const res = await fetch(`/api/host/listings/${listingId}/availability?from=${from}&to=${to}`).catch(() => null);
        if (!res?.ok) return setData(EMPTY);
        const j = (await res.json()) as {
            blockedDays: string[];
            pricedDays: { day: string; price_cents_override: number }[];
            bookedRanges: { check_in: string; check_out: string }[];
        };
        setData({
            blocked: new Set(j.blockedDays),
            priced: new Map(j.pricedDays.map((p) => [p.day, p.price_cents_override])),
            booked: occupiedNights(j.bookedRanges),
        });
    }, [listingId, days]);

    useEffect(() => {
        setSelected(new Set());
        void load();
    }, [load]);

    if (!listings.length) return <EmptyState icon={CalendarDays} title={t("noListingsTitle")} description={t("calendarNeedsListing")} />;

    const toggle = (d: string) =>
        setSelected((s) => {
            const n = new Set(s);
            if (n.has(d)) n.delete(d);
            else n.add(d);
            return n;
        });

    const save = async (available: boolean, withPrice: boolean) => {
        const cents = Math.round(Number(price.replace(",", ".")) * 100);
        setBusy(true);
        const res = await fetch(`/api/host/listings/${listingId}/availability`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dates: [...selected].sort(), available, priceCentsOverride: withPrice ? cents : null }),
        }).catch(() => null);
        setBusy(false);
        if (!res?.ok) {
            const j = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
            toast({ title: tu(errorKey(j.error)), tone: "danger" });
            return;
        }
        toast({ title: t("calendarSaved"), tone: "success" });
        setSelected(new Set());
        setPrice("");
        void load();
    };

    const title = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(cursor.y, cursor.m, 1)));
    const shift = (delta: number) => setCursor(({ y, m }) => ({ y: Math.floor((y * 12 + m + delta) / 12), m: (y * 12 + m + delta) % 12 }));
    const priceValid = Number(price.replace(",", ".")) * 100 >= limits.minPriceCents;

    return (
        <div className="space-y-3">
            <Select aria-label={t("chooseListing")} value={listingId} onChange={(e) => setListingId(e.target.value)} options={listings.map((l) => ({ value: l.id, label: l.title }))} />
            <div className="flex items-center justify-between">
                <IconButton label={tu("prevMonth")} onClick={() => shift(-1)} disabled={cursor.y * 12 + cursor.m <= Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1}>
                    <ChevronLeft aria-hidden />
                </IconButton>
                <p className="text-base font-semibold capitalize text-fg">{title}</p>
                <IconButton label={tu("nextMonth")} onClick={() => shift(1)}>
                    <ChevronRight aria-hidden />
                </IconButton>
            </div>
            <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: offset }, (_, i) => <span key={`e${i}`} />)}
                {days.map((d) => {
                    const booked = data.booked.has(d);
                    const past = d < today;
                    const sel = selected.has(d);
                    return (
                        <button
                            key={d}
                            type="button"
                            disabled={booked || past}
                            aria-pressed={sel}
                            onClick={() => toggle(d)}
                            className={cn(
                                "flex h-11 flex-col items-center justify-center rounded-control text-sm tabular-nums",
                                sel ? "bg-brand text-brand-fg" : booked ? "bg-info-soft text-info" : data.blocked.has(d) ? "bg-danger-soft text-danger line-through" : "bg-surface text-fg",
                                past && "opacity-40",
                                data.priced.has(d) && !sel && "ring-1 ring-inset ring-warning",
                            )}
                        >
                            {Number(d.slice(8, 10))}
                        </button>
                    );
                })}
            </div>
            <ul className="flex flex-wrap gap-3 text-xs text-muted">
                <li className="flex items-center gap-1"><span className="h-3 w-3 rounded bg-info-soft" />{t("legendBooked")}</li>
                <li className="flex items-center gap-1"><span className="h-3 w-3 rounded bg-danger-soft" />{t("legendBlocked")}</li>
                <li className="flex items-center gap-1"><span className="h-3 w-3 rounded ring-1 ring-warning" />{t("legendPriced")}</li>
            </ul>
            {selected.size > 0 ? (
                <div className="space-y-2 rounded-card border border-subtle bg-surface p-3">
                    <p className="text-sm font-semibold text-fg">{t("selectedDays", { count: selected.size })}</p>
                    <div className="flex gap-2">
                        <Button className="flex-1" variant="secondary" loading={busy} onClick={() => void save(false, false)}>{t("block")}</Button>
                        <Button className="flex-1" variant="secondary" loading={busy} onClick={() => void save(true, false)}>{t("unblock")}</Button>
                    </div>
                    <div className="flex gap-2">
                        <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={t("specialPrice")} aria-label={t("specialPrice")} />
                        <Button loading={busy} disabled={!priceValid} onClick={() => void save(true, true)}>{t("setPrice")}</Button>
                    </div>
                </div>
            ) : (
                <p className="text-sm text-muted">{t("calendarHint")}</p>
            )}
        </div>
    );
}
