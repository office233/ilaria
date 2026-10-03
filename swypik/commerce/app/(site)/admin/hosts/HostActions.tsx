"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

export default function HostActions({ applicationId }: { applicationId: string }) {
    const t = useTranslations("adminHosts");
    const router = useRouter();
    const [note, setNote] = useState("");
    const [loading, setLoading] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    function translateError(code: string | undefined, status: number): string {
        const known: Record<string, string> = {
            unauthorized: t("errUnauthorized"),
            invalid_data: t("errInvalidData"),
            reason_required: t("reasonRequired"),
            application_not_found_or_processed: t("errApplicationNotFoundOrProcessed"),
        };
        if (code && known[code]) return known[code];
        return t("errorWithStatus", { status });
    }

    async function run(action: "approve" | "reject" | "needs_info") {
        if (loading !== null) return;
        if (action !== "approve" && !note.trim()) {
            setError(t("reasonRequired"));
            return;
        }
        const msg =
            action === "approve"
                ? t("confirmApprove")
                : action === "reject"
                    ? t("confirmReject")
                    : t("confirmNeedsInfo");
        if (!confirm(msg)) return;
        setLoading(action);
        setError(null);
        try {
            const res = await fetch(`/api/admin/hosts/${applicationId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action, note: note.trim() || undefined }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(translateError(data?.error, res.status));
                setLoading(null);
                return;
            }
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : t("errorNetwork"));
            setLoading(null);
        }
    }

    return (
        <div className="mt-3 border-t border-black/10 pt-3">
            <label className="mb-1 block text-xs font-bold uppercase text-black/60">
                {t("noteLabelForm")}
            </label>
            <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={1000}
                className="mb-2 w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
                placeholder={t("needsInfoPlaceholder")}
            />
            {error && (
                <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
            )}
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    disabled={loading !== null}
                    onClick={() => run("approve")}
                    className="rounded-lg bg-green-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                    {loading === "approve" ? t("loading") : t("approve")}
                </button>
                <button
                    type="button"
                    disabled={loading !== null}
                    onClick={() => run("needs_info")}
                    className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                    {loading === "needs_info" ? t("loading") : t("requestDocuments")}
                </button>
                <button
                    type="button"
                    disabled={loading !== null}
                    onClick={() => run("reject")}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                    {loading === "reject" ? t("loading") : t("reject")}
                </button>
            </div>
        </div>
    );
}
