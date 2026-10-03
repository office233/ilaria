"use client";

/**
 * Panoul francizatului de flotă — vede statusul francizei și șoferii/curierii
 * alocați francizei lui (alocarea o face admin-ul la aprobare).
 */
import { useEffect, useState } from "react";
import { Link } from "@/lib/i18n/navigation";
import NextLink from "next/link";
import { Bike, Building2, Car, Loader2, Users } from "lucide-react";
import { useTranslations } from "next-intl";

type Partner = {
    id: string;
    company_name: string;
    city: string;
    vertical: string;
    status: string;
    commission_bps: number;
};

type Driver = {
    id: string;
    kind: string;
    full_name: string;
    phone: string;
    vehicle_type: string;
    vehicle_plate: string | null;
    verification_status: string;
    active: boolean;
};

type Stats = { rides_30d: number; revenue_30d_cents: number; commission_30d_cents: number };

export default function FleetPartnerClient() {
    const t = useTranslations("join");
    const [loading, setLoading] = useState(true);
    const [unauthorized, setUnauthorized] = useState(false);
    const [partner, setPartner] = useState<Partner | null>(null);
    const [drivers, setDrivers] = useState<Driver[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch("/api/fleet-partners", { credentials: "include" });
                if (res.status === 401) { setUnauthorized(true); return; }
                const data = await res.json();
                setPartner(data.partner);
                setDrivers(data.drivers ?? []);
                setStats(data.stats ?? null);
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    if (loading) {
        return <main className="grid min-h-screen place-items-center"><Loader2 className="animate-spin text-subtle" /></main>;
    }

    if (unauthorized) {
        return (
            <main className="grid min-h-screen place-items-center bg-canvas px-4">
                <div className="text-center">
                    <p className="text-[15px] font-bold text-fg">{t("fleetLoginNeeded")}</p>
                    <NextLink href="/auth/login?next=/fleet" className="mt-4 inline-block rounded-2xl bg-fg px-6 py-3 text-[14px] font-extrabold text-fg-inverse">
                        {t("login")}
                    </NextLink>
                </div>
            </main>
        );
    }

    if (!partner) {
        return (
            <main className="grid min-h-screen place-items-center bg-canvas px-4">
                <div className="w-full max-w-md rounded-3xl bg-surface p-8 text-center shadow-sm border border-subtle">
                    <Building2 size={48} className="mx-auto text-violet-500" />
                    <h1 className="mt-4 text-xl font-black text-fg">{t("noFranchiseTitle")}</h1>
                    <p className="mt-2 text-[14px] text-muted">{t("noFranchiseSub")}</p>
                    <Link href="/join/franchise" className="mt-6 block rounded-2xl bg-fg py-3 text-[14px] font-extrabold text-fg-inverse">
                        {t("applyFranchise")}
                    </Link>
                </div>
            </main>
        );
    }

    const pendingBadge = "bg-warning-soft text-warning";
    const activeBadge = "bg-success-soft text-success";

    return (
        <main className="min-h-screen bg-canvas px-4 py-8">
            <div className="mx-auto max-w-2xl">
                <div className="flex items-center gap-3">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-100">
                        <Building2 size={24} className="text-brand" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h1 className="text-xl font-black text-fg">{partner.company_name}</h1>
                        <p className="text-[13px] text-muted">
                            {partner.city} · {partner.vertical === "both" ? t("verticalBoth") : partner.vertical === "go" ? "Swypik Go" : "Swypik Food"}
                        </p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-[12px] font-bold ${partner.status === "active" ? activeBadge : pendingBadge}`}>
                        {partner.status === "active" ? t("statusActive") : t("statusPending")}
                    </span>
                </div>

                {partner.status !== "active" && (
                    <p className="mt-4 rounded-2xl bg-warning-soft px-4 py-3 text-[13px] font-semibold text-warning">
                        {t("franchisePendingNote")}
                    </p>
                )}

                {partner.status === "active" && (
                    <div className="mt-6 grid grid-cols-3 gap-3">
                        <div className="rounded-2xl bg-surface p-4 text-center shadow-sm border border-subtle">
                            <p className="text-2xl font-black text-fg">{stats?.rides_30d ?? 0}</p>
                            <p className="mt-1 text-[11px] font-bold uppercase tracking-wide text-subtle">{t("rides30d")}</p>
                        </div>
                        <div className="rounded-2xl bg-surface p-4 text-center shadow-sm border border-subtle">
                            <p className="text-2xl font-black text-fg">
                                {((stats?.revenue_30d_cents ?? 0) / 100).toFixed(0)}
                            </p>
                            <p className="mt-1 text-[11px] font-bold uppercase tracking-wide text-subtle">{t("volumeRon")}</p>
                        </div>
                        <div className="rounded-2xl bg-violet-50 p-4 text-center shadow-sm ring-1 ring-violet-200">
                            <p className="text-2xl font-black text-violet-700">
                                {((stats?.commission_30d_cents ?? 0) / 100).toFixed(0)}
                            </p>
                            <p className="mt-1 text-[11px] font-bold uppercase tracking-wide text-violet-500">
                                {t("yourCommission", { pct: ((partner.commission_bps ?? 0) / 100).toFixed(1) })}
                            </p>
                        </div>
                    </div>
                )}

                {partner.status === "active" && (
                    <div className="mt-4 rounded-2xl bg-surface p-4 shadow-sm border border-subtle">
                        <p className="text-[13px] font-bold text-fg">{t("fleet.recruitTitle" as never)}</p>
                        <p className="mt-1 text-[12px] text-muted">
                            {t("recruitNote", { city: partner.city })}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                            <a href="/join/fleet?kind=driver" className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2 text-[12px] font-bold text-white">
                                <Car size={14} /> {t("driverLinkGo")}
                            </a>
                            <a href="/join/fleet?kind=courier" className="inline-flex items-center gap-1.5 rounded-xl bg-success px-3 py-2 text-[12px] font-bold text-white">
                                <Bike size={14} /> {t("courierLinkFood")}
                            </a>
                        </div>
                    </div>
                )}

                <section className="mt-8">
                    <h2 className="flex items-center gap-2 text-lg font-extrabold text-fg">
                        <Users size={20} /> {t("myDrivers")} ({drivers.length})
                    </h2>
                    <div className="mt-3 space-y-2">
                        {drivers.map((d) => (
                            <div key={d.id} className="flex items-center gap-3 rounded-2xl bg-surface p-4 shadow-sm border border-subtle">
                                <span className="text-xl">{d.kind === "driver" ? <Car size={20} /> : <Bike size={20} />}</span>
                                <div className="min-w-0 flex-1">
                                    <p className="text-[14px] font-bold text-fg">{d.full_name}</p>
                                    <p className="text-[12px] text-muted">
                                        {d.phone} · {d.vehicle_type}{d.vehicle_plate ? ` · ${d.vehicle_plate}` : ""}
                                    </p>
                                </div>
                                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${d.active ? activeBadge : pendingBadge}`}>
                                    {d.active ? t("statusActive") : d.verification_status}
                                </span>
                            </div>
                        ))}
                        {drivers.length === 0 && (
                            <p className="rounded-2xl bg-surface p-6 text-center text-[13px] text-subtle shadow-sm border border-subtle">
                                {t("noDriversYet")}
                            </p>
                        )}
                    </div>
                </section>
            </div>
        </main>
    );
}
