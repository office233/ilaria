"use client";

/** Câmp „Check-in – Check-out” care deschide calendarul într-un sheet de jos. */
import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { nightsCount } from "@/lib/stays/dates";
import type { Range } from "@/lib/stays/range-select";
import { cn } from "@/lib/ui/cn";
import { DateRangePicker } from "./DateRangePicker";
import { useStaysFormat } from "./format";

type Props = {
    value: Range;
    onChange: (r: Range) => void;
    minDate: string;
    maxNights: number;
    occupied?: ReadonlySet<string>;
    className?: string;
};

export function DateRangeField({ value, onChange, minDate, maxNights, occupied, className }: Props) {
    const t = useTranslations("staysUi");
    const f = useStaysFormat();
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<Range>(value);
    const complete = Boolean(value.checkIn && value.checkOut);
    const nights = complete ? nightsCount(value.checkIn!, value.checkOut!) : 0;

    return (
        <>
            <button
                type="button"
                onClick={() => {
                    setDraft(value);
                    setOpen(true);
                }}
                className={cn(
                    "flex min-h-11 w-full items-center gap-3 rounded-control border border-subtle bg-surface px-3.5 py-2 text-left",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                    className,
                )}
            >
                <CalendarDays className="h-5 w-5 shrink-0 text-subtle" aria-hidden />
                <span className="min-w-0 flex-1">
                    <span className="block text-xs text-muted">{t("datesLabel")}</span>
                    <span className={cn("block truncate text-base", complete ? "text-fg" : "text-subtle")}>
                        {complete
                            ? `${f.date(value.checkIn!)} – ${f.date(value.checkOut!)} · ${t("nights", { count: nights })}`
                            : t("datesPlaceholder")}
                    </span>
                </span>
            </button>
            <Sheet
                open={open}
                onOpenChange={setOpen}
                title={t("datesSheetTitle")}
                description={
                    draft.checkIn && !draft.checkOut ? t("pickCheckout") : !draft.checkIn ? t("pickCheckin") : undefined
                }
                footer={
                    <div className="flex gap-2">
                        <Button variant="secondary" className="flex-1" onClick={() => setDraft({ checkIn: null, checkOut: null })}>
                            {t("clearDates")}
                        </Button>
                        <Button
                            className="flex-1"
                            disabled={Boolean(draft.checkIn) && !draft.checkOut}
                            onClick={() => {
                                onChange(draft);
                                setOpen(false);
                            }}
                        >
                            {t("done")}
                        </Button>
                    </div>
                }
            >
                <DateRangePicker value={draft} onChange={setDraft} minDate={minDate} maxNights={maxNights} occupied={occupied} />
            </Sheet>
        </>
    );
}
