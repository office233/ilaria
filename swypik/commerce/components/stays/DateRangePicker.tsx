"use client";

/**
 * Calendar de interval pentru telefon: lună cu lună, celule de 44px, nopțile
 * ocupate tăiate și ne-selectabile (cu excepția unei zile de check-out valide).
 */
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/ui/cn";
import { isSelectable, monthGrid, nextRange, type Range } from "@/lib/stays/range-select";

export type DateRangePickerProps = {
    value: Range;
    onChange: (r: Range) => void;
    minDate: string;
    occupied?: ReadonlySet<string>;
    maxNights: number;
    /** Câte luni înainte se poate naviga. */
    monthsAhead?: number;
};

const EMPTY: ReadonlySet<string> = new Set();

export function DateRangePicker({ value, onChange, minDate, occupied = EMPTY, maxNights, monthsAhead = 12 }: DateRangePickerProps) {
    const t = useTranslations("staysUi");
    const locale = useLocale();
    const start = value.checkIn ?? minDate;
    const base = { y: Number(minDate.slice(0, 4)), m: Number(minDate.slice(5, 7)) - 1 };
    const [cursor, setCursor] = useState(() => ({ y: Number(start.slice(0, 4)), m: Number(start.slice(5, 7)) - 1 }));
    const monthIndex = (cursor.y - base.y) * 12 + (cursor.m - base.m);

    const { offset, days } = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor]);
    const title = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
        new Date(Date.UTC(cursor.y, cursor.m, 1)),
    );
    const weekdays = useMemo(() => {
        const f = new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" });
        return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2024, 0, 1 + i))));
    }, [locale]);
    const longDate = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" });

    const shift = (delta: number) =>
        setCursor(({ y, m }) => {
            const idx = y * 12 + m + delta;
            return { y: Math.floor(idx / 12), m: idx % 12 };
        });

    return (
        <div className="select-none">
            <div className="mb-2 flex items-center justify-between">
                <IconButton label={t("prevMonth")} onClick={() => shift(-1)} disabled={monthIndex <= 0}>
                    <ChevronLeft aria-hidden />
                </IconButton>
                <p className="text-base font-semibold capitalize text-fg" aria-live="polite">
                    {title}
                </p>
                <IconButton label={t("nextMonth")} onClick={() => shift(1)} disabled={monthIndex >= monthsAhead}>
                    <ChevronRight aria-hidden />
                </IconButton>
            </div>
            <div className="grid grid-cols-7 text-center text-xs font-medium text-subtle" aria-hidden>
                {weekdays.map((w, i) => (
                    <span key={i} className="py-1">
                        {w}
                    </span>
                ))}
            </div>
            <div className="grid grid-cols-7 gap-y-1" role="grid">
                {Array.from({ length: offset }, (_, i) => (
                    <span key={`e${i}`} />
                ))}
                {days.map((day) => {
                    const selectable = isSelectable(value, day, minDate, occupied, maxNights);
                    const isStart = day === value.checkIn;
                    const isEnd = day === value.checkOut;
                    const inRange = Boolean(value.checkIn && value.checkOut && day > value.checkIn && day < value.checkOut);
                    const taken = occupied.has(day) && day >= minDate;
                    return (
                        <button
                            key={day}
                            type="button"
                            disabled={!selectable}
                            aria-pressed={isStart || isEnd}
                            aria-label={`${longDate.format(new Date(`${day}T00:00:00Z`))}${taken ? ` · ${t("unavailable")}` : ""}`}
                            onClick={() => onChange(nextRange(value, day, occupied, maxNights))}
                            className={cn(
                                "flex h-11 items-center justify-center text-sm tabular-nums transition-colors duration-fast",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                                inRange && "bg-brand-soft text-brand-soft-fg",
                                (isStart || isEnd) && "rounded-control bg-brand font-semibold text-brand-fg",
                                !inRange && !isStart && !isEnd && selectable && "rounded-control text-fg hover:bg-surface-2",
                                !selectable && "cursor-not-allowed text-subtle",
                                taken && !isEnd && "line-through",
                            )}
                        >
                            {Number(day.slice(8, 10))}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
