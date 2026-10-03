"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

type Partner = { id: string; company_name: string };

const BTN = "rounded-lg px-3 py-1.5 text-[12px] font-bold disabled:opacity-50";

export default function FleetActions({
    courierId,
    status,
    active,
    partners,
}: {
    courierId: string;
    status: string;
    active?: boolean;
    partners: Partner[];
}) {
    const t = useTranslations("adminFleet");
    const router = useRouter();
    const [loading, setLoading] = useState<string | null>(null);
    const [partnerId, setPartnerId] = useState("");

    async function run(action: "approve" | "reject" | "suspend" | "reactivate" | "delete") {
        const labels: Record<string, string> = {
            approve: t("confirmApprove"),
            reject: t("confirmReject"),
            suspend: t("confirmSuspend"),
            reactivate: t("confirmReactivate"),
            delete: t("confirmDelete"),
        };
        if (!confirm(labels[action])) return;
        setLoading(action);
        try {
            const res = await fetch(`/api/admin/fleet/${courierId}`, {
                method: "PATCH",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action, fleet_partner_id: partnerId || undefined }),
            });
            if (res.ok) router.refresh();
            else {
                // Aprobarea cere documentele obligatorii aprobate și neexpirate (revizia în /admin/go).
                const j = (await res.json().catch(() => null)) as { error?: string } | null;
                alert(j?.error === "documents_missing" ? t("documentsMissing") : t("saveError"));
            }
        } finally {
            setLoading(null);
        }
    }

    return (
        <div className="flex flex-wrap items-center gap-2">
            {status === "pending" && (
                <>
                    {partners.length > 0 && (
                        <select
                            value={partnerId}
                            onChange={(e) => setPartnerId(e.target.value)}
                            className="rounded-lg border border-subtle px-2 py-1.5 text-[12px] font-semibold"
                        >
                            <option value="">{t("directFleet")}</option>
                            {partners.map((p) => (
                                <option key={p.id} value={p.id}>{t("franchisePrefix")} {p.company_name}</option>
                            ))}
                        </select>
                    )}
                    <button type="button" disabled={loading !== null} onClick={() => run("approve")} className={`${BTN} bg-success text-white`}>
                        {loading === "approve" ? "…" : t("approve")}
                    </button>
                    <button type="button" disabled={loading !== null} onClick={() => run("reject")} className={`${BTN} bg-danger text-white`}>
                        {loading === "reject" ? "…" : t("reject")}
                    </button>
                </>
            )}

            {status === "approved" && active !== false && (
                <button type="button" disabled={loading !== null} onClick={() => run("suspend")} className={`${BTN} bg-surface-2 text-muted`}>
                    {loading === "suspend" ? "…" : t("suspend")}
                </button>
            )}

            {status === "approved" && active === false && (
                <button type="button" disabled={loading !== null} onClick={() => run("reactivate")} className={`${BTN} bg-success text-white`}>
                    {loading === "reactivate" ? "…" : t("reactivate")}
                </button>
            )}

            {status === "rejected" && (
                <button type="button" disabled={loading !== null} onClick={() => run("approve")} className={`${BTN} bg-success text-white`}>
                    {loading === "approve" ? "…" : t("approveAnyway")}
                </button>
            )}

            <button
                type="button"
                disabled={loading !== null}
                onClick={() => run("delete")}
                title={t("deleteForever")}
                className={`${BTN} bg-surface text-danger ring-1 ring-danger/30 hover:bg-danger-soft`}
            >
                {loading === "delete" ? "…" : t("delete")}
            </button>
        </div>
    );
}

/** Acțiuni pe franciză: aprobă / respinge / suspendă / reactivează / șterge. */
export function PartnerActions({ partnerId, status }: { partnerId: string; status: string }) {
    const t = useTranslations("adminFleet");
    const router = useRouter();
    const [loading, setLoading] = useState<string | null>(null);

    async function run(action: "approve" | "reject" | "suspend" | "reactivate" | "delete") {
        const labels: Record<string, string> = {
            approve: t("confirmApprovePartner"),
            reject: t("confirmRejectPartner"),
            suspend: t("confirmSuspendPartner"),
            reactivate: t("confirmReactivatePartner"),
            delete: t("confirmDeletePartner"),
        };
        if (!confirm(labels[action])) return;
        setLoading(action);
        try {
            const res = await fetch(`/api/admin/fleet-partners/${partnerId}`, {
                method: "PATCH",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action }),
            });
            if (res.ok) router.refresh();
            else {
                // Aprobarea cere documentele obligatorii aprobate și neexpirate (revizia în /admin/go).
                const j = (await res.json().catch(() => null)) as { error?: string } | null;
                alert(j?.error === "documents_missing" ? t("documentsMissing") : t("saveError"));
            }
        } finally {
            setLoading(null);
        }
    }

    return (
        <div className="flex flex-wrap items-center gap-2">
            {status === "pending" && (
                <>
                    <button type="button" disabled={loading !== null} onClick={() => run("approve")} className={`${BTN} bg-success text-white`}>
                        {loading === "approve" ? "…" : t("approve")}
                    </button>
                    <button type="button" disabled={loading !== null} onClick={() => run("reject")} className={`${BTN} bg-danger text-white`}>
                        {loading === "reject" ? "…" : t("reject")}
                    </button>
                </>
            )}
            {status === "active" && (
                <button type="button" disabled={loading !== null} onClick={() => run("suspend")} className={`${BTN} bg-surface-2 text-muted`}>
                    {loading === "suspend" ? "…" : t("suspend")}
                </button>
            )}
            {(status === "suspended" || status === "rejected") && (
                <button type="button" disabled={loading !== null} onClick={() => run("reactivate")} className={`${BTN} bg-success text-white`}>
                    {loading === "reactivate" ? "…" : t("activate")}
                </button>
            )}
            <button type="button" disabled={loading !== null} onClick={() => run("delete")} className={`${BTN} bg-surface text-danger ring-1 ring-danger/30 hover:bg-danger-soft`}>
                {loading === "delete" ? "…" : t("delete")}
            </button>
        </div>
    );
}
