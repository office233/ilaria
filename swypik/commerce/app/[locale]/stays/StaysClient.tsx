"use client";

/**
 * Swypik Stays — căutare în cazările gazdelor Swypik (inventar propriu).
 * Mobile-first: destinație, interval (calendar în sheet), oaspeți; rezultate
 * cu stări de încărcare / gol / eroare. Fără promisiuni false („1M+”).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CalendarCheck, Home, MapPin, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { DateRangeField } from "@/components/stays/DateRangeField";
import { GuestStepper } from "@/components/stays/GuestStepper";
import { StayCard } from "@/components/stays/StayCard";
import { Link } from "@/lib/i18n/navigation";
import { todayIso } from "@/lib/stays/dates";
import type { Range } from "@/lib/stays/range-select";
import type { StayResult } from "@/lib/stays/search";

type Props = { maxNights: number; maxGuests: number };
type Filters = { q: string; range: Range; guests: number };

function toQuery(f: Filters): string {
    const p = new URLSearchParams();
    if (f.q.trim()) p.set("q", f.q.trim());
    if (f.range.checkIn && f.range.checkOut) {
        p.set("checkIn", f.range.checkIn);
        p.set("checkOut", f.range.checkOut);
    }
    p.set("guests", String(f.guests));
    return p.toString();
}

export default function StaysClient({ maxNights, maxGuests }: Props) {
    const t = useTranslations("staysUi");
    const [filters, setFilters] = useState<Filters>({ q: "", range: { checkIn: null, checkOut: null }, guests: 2 });
    const [applied, setApplied] = useState<Filters>(filters);
    const [results, setResults] = useState<StayResult[] | null>(null);
    const [failed, setFailed] = useState(false);

    const load = useCallback(async (f: Filters) => {
        setResults(null);
        setFailed(false);
        try {
            const res = await fetch(`/api/stays/search?${toQuery(f)}`);
            if (!res.ok) throw new Error(String(res.status));
            const j = (await res.json()) as { results: StayResult[] };
            setResults(j.results);
        } catch {
            setFailed(true);
        }
    }, []);

    useEffect(() => {
        void load(applied);
    }, [applied, load]);

    const submit = (e: FormEvent) => {
        e.preventDefault();
        setApplied(filters);
    };
    const filtered = Boolean(applied.q.trim() || applied.range.checkIn);
    const detailQuery = applied.range.checkIn ? toQuery({ ...applied, q: "" }) : undefined;

    return (
        <div className="min-h-dvh bg-canvas">
            <PageHeader
                title={t("title")}
                actions={
                    <IconButton asChild label={t("myBookings")}>
                        <Link href="/account/stays">
                            <CalendarCheck aria-hidden />
                        </Link>
                    </IconButton>
                }
            />
            <main className="mx-auto max-w-lg space-y-4 px-gutter py-4">
                <Card padding="md" className="shadow-elev-1">
                    <form onSubmit={submit} className="space-y-3" role="search">
                        <Input
                            leadingIcon={<MapPin aria-hidden />}
                            value={filters.q}
                            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
                            placeholder={t("destinationPlaceholder")}
                            aria-label={t("destinationLabel")}
                            enterKeyHint="search"
                            maxLength={80}
                        />
                        <DateRangeField
                            value={filters.range}
                            onChange={(range) => setFilters({ ...filters, range })}
                            minDate={todayIso()}
                            maxNights={maxNights}
                        />
                        <GuestStepper value={filters.guests} max={maxGuests} onChange={(guests) => setFilters({ ...filters, guests })} />
                        <Button type="submit" block size="lg">
                            <Search className="h-4 w-4" aria-hidden />
                            {t("searchButton")}
                        </Button>
                    </form>
                </Card>

                <section aria-live="polite" aria-busy={results === null && !failed} className="space-y-3">
                    {failed ? (
                        <ErrorState title={t("searchErrorTitle")} description={t("searchErrorBody")} onRetry={() => void load(applied)} />
                    ) : results === null ? (
                        Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="aspect-[16/12] w-full rounded-card" />)
                    ) : results.length === 0 ? (
                        <EmptyState
                            icon={Home}
                            title={filtered ? t("emptyFilteredTitle") : t("emptyTitle")}
                            description={filtered ? t("emptyFilteredBody") : t("emptyBody")}
                            action={
                                filtered ? (
                                    <Button variant="secondary" onClick={() => setApplied({ ...filters, q: "", range: { checkIn: null, checkOut: null } })}>
                                        {t("clearFilters")}
                                    </Button>
                                ) : undefined
                            }
                        />
                    ) : (
                        <>
                            <p className="text-sm text-muted">{t("resultsCount", { count: results.length })}</p>
                            {results.map((s) => (
                                <StayCard key={s.id} stay={s} query={detailQuery} />
                            ))}
                        </>
                    )}
                </section>

                <Card variant="muted" padding="md" className="flex items-center gap-3">
                    <Home className="h-6 w-6 shrink-0 text-brand" aria-hidden />
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-fg">{t("hostCtaTitle")}</p>
                        <p className="text-sm text-muted">{t("hostCtaBody")}</p>
                    </div>
                    <Button asChild variant="soft" size="sm">
                        <Link href="/stays/manage">{t("hostCtaButton")}</Link>
                    </Button>
                </Card>
            </main>
        </div>
    );
}
