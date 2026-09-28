"use client";

/**
 * Butoane Aprobă / Respinge pentru aplicațiile de restaurant (local_merchants pending)
 * din coada unificată /admin/aplicatii.
 */
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ui/ConfirmDialog";

export default function MerchantActions({ merchantId }: { merchantId: string }) {
    const t = useTranslations("adminApplications");
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();

    async function act(action: "approve" | "reject") {
        if (pending) return;
        if (
            action === "reject" &&
            !(await confirm({ title: t("confirmRejectRestaurant"), confirmLabel: t("reject"), tone: "danger" }))
        ) {
            return;
        }
        setError(null);
        const res = await fetch(`/api/admin/merchants/${merchantId}/${action}`, { method: "POST" });
        if (!res.ok) {
            setError(t("errorRetry"));
            return;
        }
        startTransition(() => router.refresh());
    }

    return (
        <span className="inline-flex items-center gap-2">
            <button
                type="button"
                disabled={pending}
                onClick={() => act("approve")}
                className="rounded-full bg-green-600 px-3 py-1 text-[11px] font-bold text-white hover:bg-green-700 disabled:opacity-50"
            >
                {t("approve")}
            </button>
            <button
                type="button"
                disabled={pending}
                onClick={() => act("reject")}
                className="rounded-full bg-red-100 px-3 py-1 text-[11px] font-bold text-red-600 hover:bg-red-200 disabled:opacity-50"
            >
                {t("reject")}
            </button>
            {error && <span className="text-[11px] text-red-600">{error}</span>}
            {confirmDialog}
        </span>
    );
}
