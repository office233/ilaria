/**
 * Admin Fleet — verificarea aplicațiilor de șoferi (Go) și curieri (Food)
 * + lista francizelor de flotă.
 */
import { dbQuery } from "@/lib/db";
import { Car, Bike, Circle, CircleDot } from "lucide-react";
import { requireAdminSession } from "@/lib/security/admin-auth";
import { getTranslations } from "next-intl/server";
import FleetActions, { PartnerActions } from "./FleetActions";

export const dynamic = "force-dynamic";

type CourierRow = {
    id: string;
    kind: string;
    full_name: string;
    phone: string;
    email: string | null;
    city: string;
    vehicle_type: string;
    vehicle_plate: string | null;
    verification_status: string;
    active: boolean;
    fleet_partner_id: string | null;
    created_at: string;
    // Cont + telemetrie
    user_id: string | null;
    login_email: string | null;
    is_online: boolean;
    current_lat: number | null;
    current_lng: number | null;
    location_updated_at: string | null;
    last_ip: string | null;
    last_seen_at: string | null;
};

type PartnerRow = {
    id: string;
    company_name: string;
    city: string;
    vertical: string;
    status: string;
    phone: string;
    driver_count: number;
};

const STATUS_BADGE: Record<string, string> = {
    pending: "bg-warning-soft text-warning",
    approved: "bg-success-soft text-success",
    rejected: "bg-danger-soft text-danger",
};

export default async function AdminFleetPage() {
    await requireAdminSession();
    const t = await getTranslations("adminFleet");

    const [{ rows: couriers }, { rows: partners }] = await Promise.all([
        dbQuery<CourierRow>(
            `SELECT c.id, c.kind, c.full_name, c.phone, c.email, c.city, c.vehicle_type, c.vehicle_plate,
                            c.verification_status, c.active, c.fleet_partner_id, c.created_at,
                            c.user_id::text, u.email AS login_email, c.is_online,
                            c.current_lat, c.current_lng, c.location_updated_at::text,
                                s.ip_address::text AS last_ip, s.last_seen_at
                 FROM couriers c
                 LEFT JOIN users u ON u.id = c.user_id
                 LEFT JOIN LATERAL (
                                SELECT ip_address, COALESCE(last_seen_at, created_at)::text AS last_seen_at
                                FROM user_sessions
                             WHERE user_id = c.user_id
                                ORDER BY COALESCE(last_seen_at, created_at) DESC
                             LIMIT 1
                 ) s ON true
                WHERE c.deleted_at IS NULL
                ORDER BY (c.verification_status = 'pending') DESC, c.created_at DESC
        LIMIT 100`,
        ),
        dbQuery<PartnerRow>(
            `SELECT fp.id, fp.company_name, fp.city, fp.vertical, fp.status, fp.phone,
              COUNT(c.id)::int AS driver_count
         FROM fleet_partners fp
         LEFT JOIN couriers c ON c.fleet_partner_id = fp.id
        GROUP BY fp.id
        ORDER BY fp.created_at DESC
        LIMIT 50`,
        ),
    ]);

    const pending = couriers.filter((c) => c.verification_status === "pending");
    const activeCount = couriers.filter((c) => c.verification_status === "approved" && c.active).length;
    const inactiveCount = couriers.filter((c) => c.verification_status === "approved" && !c.active).length;
    const rejectedCount = couriers.filter((c) => c.verification_status === "rejected").length;

    return (
        <div className="p-6">
            <h1 className="text-2xl font-black text-fg">
                {t("title")}{" "}
                {pending.length > 0 && (
                    <span className="ml-2 rounded-full bg-warning-soft px-3 py-1 text-sm font-bold text-warning">
                        {t("pendingCount", { count: pending.length })}
                    </span>
                )}
            </h1>
            <div className="mt-3 flex flex-wrap gap-2 text-[12px] font-bold">
                <span className="rounded-full bg-success-soft px-3 py-1 text-success">{t("activeCount", { count: activeCount })}</span>
                <span className="rounded-full bg-surface-2 px-3 py-1 text-muted">{t("suspendedCount", { count: inactiveCount })}</span>
                <span className="rounded-full bg-danger-soft px-3 py-1 text-danger">{t("rejectedCount", { count: rejectedCount })}</span>
                <span className="rounded-full bg-surface-2 px-3 py-1 text-muted">{t("totalCount", { count: couriers.length })}</span>
            </div>

            <section className="mt-6">
                <h2 className="mb-3 text-lg font-extrabold">{t("applicationsTitle")}</h2>
                <div className="overflow-x-auto rounded-2xl border border-subtle bg-surface">
                    <table className="w-full text-left text-[13px]">
                        <thead className="border-b border-subtle text-[11px] uppercase tracking-wide text-muted">
                            <tr>
                                <th className="px-4 py-3">{t("thName")}</th>
                                <th className="px-4 py-3">{t("thType")}</th>
                                <th className="px-4 py-3">{t("thContact")}</th>
                                <th className="px-4 py-3">{t("thLoginAccount")}</th>
                                <th className="px-4 py-3">{t("thCity")}</th>
                                <th className="px-4 py-3">{t("thVehicle")}</th>
                                <th className="px-4 py-3">{t("thLocationIp")}</th>
                                <th className="px-4 py-3">{t("thStatus")}</th>
                                <th className="px-4 py-3">{t("thActions")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {couriers.map((c) => (
                                <tr key={c.id} className="border-b border-subtle last:border-0">
                                    <td className="px-4 py-3 font-bold">{c.full_name}</td>
                                    <td className="px-4 py-3"><span className="inline-flex items-center gap-1">{c.kind === "driver" ? <Car size={14} /> : <Bike size={14} />} {c.kind === "driver" ? "Go" : "Food"}</span></td>
                                    <td className="px-4 py-3">
                                        {c.phone}
                                        {c.email && <span className="block text-[11px] text-subtle">{c.email}</span>}
                                    </td>
                                    <td className="px-4 py-3">
                                        {c.user_id ? (
                                            <>
                                                <span className="text-[12px] font-medium">{c.login_email ?? "—"}</span>
                                                <span className="block font-mono text-[10px] text-subtle" title="user_id">{c.user_id.slice(0, 8)}…</span>
                                            </>
                                        ) : (
                                            <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-bold text-warning" title={t("noAccountTitle")}>
                                                {t("noAccount")}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3">{c.city}</td>
                                    <td className="px-4 py-3">
                                        {c.vehicle_type}
                                        {c.vehicle_plate && <span className="block text-[11px] text-subtle">{c.vehicle_plate}</span>}
                                    </td>
                                    <td className="px-4 py-3">
                                        {c.current_lat !== null && c.current_lng !== null ? (
                                            <a
                                                href={`https://www.openstreetmap.org/?mlat=${c.current_lat}&mlon=${c.current_lng}#map=16/${c.current_lat}/${c.current_lng}`}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="text-[12px] font-medium text-info underline"
                                                title={c.location_updated_at ? t("updatedAt", { time: c.location_updated_at }) : undefined}
                                            >
                                                {c.is_online ? <CircleDot size={12} className="inline text-success" /> : <Circle size={12} className="inline text-subtle" />} {Number(c.current_lat).toFixed(4)}, {Number(c.current_lng).toFixed(4)}
                                            </a>
                                        ) : (
                                            <span className="text-[11px] text-subtle">{c.is_online ? t("onlineNoGps") : t("noLocation")}</span>
                                        )}
                                        {c.last_ip && (
                                            <span className="block font-mono text-[10px] text-subtle" title={c.last_seen_at ? t("lastSession", { time: c.last_seen_at }) : undefined}>
                                                IP {c.last_ip}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3">
                                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS_BADGE[c.verification_status] ?? "bg-surface-2 text-muted"}`}>
                                            {c.verification_status}
                                        </span>
                                        {!c.active && c.verification_status === "approved" && (
                                            <span className="ml-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold text-muted">{t("suspended")}</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3">
                                        <FleetActions
                                            courierId={c.id}
                                            status={c.verification_status}
                                            active={c.active}
                                            partners={partners.filter((p) => p.status === "active" && p.city.toLowerCase() === c.city.toLowerCase())}
                                        />
                                    </td>
                                </tr>
                            ))}
                            {couriers.length === 0 && (
                                <tr><td colSpan={7} className="px-4 py-8 text-center text-subtle">{t("noApplications")}</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="mt-10">
                <h2 className="mb-3 text-lg font-extrabold">{t("franchisesTitle")}</h2>
                <div className="overflow-x-auto rounded-2xl border border-subtle bg-surface">
                    <table className="w-full text-left text-[13px]">
                        <thead className="border-b border-subtle text-[11px] uppercase tracking-wide text-muted">
                            <tr>
                                <th className="px-4 py-3">{t("thCompany")}</th>
                                <th className="px-4 py-3">{t("thCity")}</th>
                                <th className="px-4 py-3">{t("thVertical")}</th>
                                <th className="px-4 py-3">{t("thDrivers")}</th>
                                <th className="px-4 py-3">{t("thStatus")}</th>
                                <th className="px-4 py-3">{t("thActions")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {partners.map((p) => (
                                <tr key={p.id} className="border-b border-subtle last:border-0">
                                    <td className="px-4 py-3 font-bold">{p.company_name}<span className="block text-[11px] font-normal text-subtle">{p.phone}</span></td>
                                    <td className="px-4 py-3">{p.city}</td>
                                    <td className="px-4 py-3"><span className="inline-flex items-center gap-1">{p.vertical === "both" ? "Go + Food" : p.vertical === "go" ? <><Car size={14} /> Go</> : <><Bike size={14} /> Food</>}</span></td>
                                    <td className="px-4 py-3">{p.driver_count}</td>
                                    <td className="px-4 py-3">
                                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${p.status === "active" ? "bg-success-soft text-success" : STATUS_BADGE[p.status] ?? "bg-surface-2 text-muted"}`}>
                                            {p.status}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3">
                                        <PartnerActions partnerId={p.id} status={p.status} />
                                    </td>
                                </tr>
                            ))}
                            {partners.length === 0 && (
                                <tr><td colSpan={6} className="px-4 py-8 text-center text-subtle">{t("noFranchises")}</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}
