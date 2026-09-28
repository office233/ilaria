"use client";

/**
 * Panoul gazdei (/stays/manage): cereri & rezervări, listări (CRUD), calendar.
 * Gazdele neaprobate văd doar invitația de a aplica.
 */
import { useCallback, useEffect, useState } from "react";
import { Home } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Link } from "@/lib/i18n/navigation";
import type { HostListing } from "@/lib/stays/listings";
import AvailabilityCalendar from "./AvailabilityCalendar";
import HostBookings from "./HostBookings";
import HostListings from "./HostListings";

export type HostLimits = { maxNights: number; maxGuests: number; maxPhotos: number; minPriceCents: number; maxPriceCents: number };
type State = { status: "loading" } | { status: "error" } | { status: "ready"; approved: boolean; listings: HostListing[]; defaultCity: string | null };

export default function HostPanelClient({ limits }: { limits: HostLimits }) {
    const t = useTranslations("staysHost");
    const [state, setState] = useState<State>({ status: "loading" });

    const load = useCallback(async () => {
        try {
            const res = await fetch("/api/host/listings");
            if (res.status === 401) {
                setState({ status: "ready", approved: false, listings: [], defaultCity: null });
                return;
            }
            if (!res.ok) throw new Error(String(res.status));
            const j = (await res.json()) as { approved: boolean; listings: HostListing[]; host: { city: string | null } | null };
            setState({ status: "ready", approved: j.approved, listings: j.listings, defaultCity: j.host?.city ?? null });
        } catch {
            setState({ status: "error" });
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    return (
        <div className="min-h-dvh bg-canvas">
            <PageHeader back="/stays" title={t("title")} subtitle={t("subtitle")} />
            <main className="mx-auto max-w-lg px-gutter py-4">
                {state.status === "loading" ? (
                    <div className="space-y-3">
                        <Skeleton className="h-11 w-full rounded-control" />
                        <Skeleton className="h-28 w-full rounded-card" />
                        <Skeleton className="h-28 w-full rounded-card" />
                    </div>
                ) : state.status === "error" ? (
                    <ErrorState onRetry={() => void load()} />
                ) : !state.approved ? (
                    <EmptyState
                        icon={Home}
                        title={t("notHostTitle")}
                        description={t("notHostBody")}
                        action={
                            <Button asChild>
                                <Link href="/join/host">{t("becomeHost")}</Link>
                            </Button>
                        }
                    />
                ) : (
                    <Tabs defaultValue="bookings">
                        <TabsList variant="pill" className="mb-4">
                            <TabsTrigger value="bookings">{t("tabBookings")}</TabsTrigger>
                            <TabsTrigger value="listings">{t("tabListings")}</TabsTrigger>
                            <TabsTrigger value="calendar">{t("tabCalendar")}</TabsTrigger>
                        </TabsList>
                        <TabsContent value="bookings">
                            <HostBookings />
                        </TabsContent>
                        <TabsContent value="listings">
                            <HostListings listings={state.listings} limits={limits} defaultCity={state.defaultCity} onChanged={() => void load()} />
                        </TabsContent>
                        <TabsContent value="calendar">
                            <AvailabilityCalendar listings={state.listings} limits={limits} />
                        </TabsContent>
                    </Tabs>
                )}
            </main>
        </div>
    );
}
