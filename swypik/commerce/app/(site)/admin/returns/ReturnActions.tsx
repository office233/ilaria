"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

/**
 * Approve / Reject buttons for a single return request.
 * Client component so the buttons can disable themselves immediately on
 * click (double-submit protection) instead of relying on a plain <form>
 * POST, which a slow network / doubleclick could otherwise fire twice.
 */
export default function ReturnActions({
  orderId,
  status,
}: {
  orderId: string;
  status: string | null;
}) {
  const t = useTranslations("adminReturns");
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);

  const canAct = status === "requested" || status === null;

  async function submit(kind: "approve" | "reject") {
    if (pending) return;
    setPending(kind);
    try {
      const body =
        kind === "reject" ? { reason: t("defaultRejectReason") } : {};
      await fetch(`/api/admin/returns/${orderId}/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  if (!canAct) {
    return (
      <Link
        href={`/admin/orders/${orderId}`}
        className="text-xs font-bold text-gray-600 hover:text-[#0D0D0D]"
      >
        {t("viewBtn")}
      </Link>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      <Link
        href={`/admin/orders/${orderId}`}
        className="px-2 py-1 rounded text-[11px] font-bold border border-[#E5E5E5] text-gray-700 hover:bg-[#F7F7F8]"
      >
        {t("viewBtn")}
      </Link>
      <button
        type="button"
        disabled={!!pending}
        onClick={() => submit("approve")}
        className="px-2 py-1 rounded text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {pending === "approve" ? t("processing") : t("approveBtn")}
      </button>
      <button
        type="button"
        disabled={!!pending}
        onClick={() => submit("reject")}
        className="px-2 py-1 rounded text-[11px] font-bold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
      >
        {pending === "reject" ? t("processing") : t("rejectBtn")}
      </button>
    </div>
  );
}
