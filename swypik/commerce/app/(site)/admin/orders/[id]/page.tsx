"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import Link from "next/link";
import { Rocket, Package, Eye, Truck } from "lucide-react";
import { useParams } from "next/navigation";
import { useConfirm } from "@/components/ui/ConfirmDialog";

type OrderItem = {
  title: string;
  quantity: number;
  unit_price: number | string;
};

type AdminOrder = {
  id: string;
  status: string;
  fulfillmentStatus?: string | null;
  statusLabel?: string;
  statusDetail?: string;
  totalRon: number;
  createdAt: string;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  shipping?: {
    name?: string;
    phone?: string;
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    country?: string;
  } | null;
};

export default function AdminOrderDetailPage() {
  const t = useTranslations("adminOrders");
  const locale = useLocale();
  const params = useParams();
  const orderId = params.id as string;

  const [order, setOrder] = useState<AdminOrder | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [toast, setToast] = useState("");
  const [showTrackingModal, setShowTrackingModal] = useState(false);
  const [trackingInput, setTrackingInput] = useState("");

  const loadOrder = useCallback(async () => {
    try {
      const res = await fetch(`/api/orders/${orderId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.error) {
        setOrder(data);
        setItems(data.items || []);
      }
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => { loadOrder(); }, [loadOrder]);

  function translateActionError(code: string | undefined): string {
    switch (code) {
      case "tracking_number_required":
      case "invalid_body":
        return t("unknownError");
      default:
        return code || t("unknownError");
    }
  }

  async function doAction(action: string, extra: Record<string, string> = {}) {
    if (actionLoading) return; // double-submit protection
    setActionLoading(action);
    try {
      const res = await fetch("/api/admin/fulfillment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, orderId, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast(t("toastErrorPrefix", { msg: translateActionError(data.error) }));
        setTimeout(() => setToast(""), 4000);
        return;
      }
      if (data.success) {
        setToast(
          action === "fulfill" ? t("toastFulfilled") :
            action === "add_tracking" ? t("toastTrackingAdded") :
              action === "cancel" ? t("toastCancelled") : t("toastActionDone")
        );
        setTimeout(() => setToast(""), 3000);
        loadOrder(); // reload
      } else {
        setToast(t("toastErrorPrefix", { msg: translateActionError(data.error) }));
        setTimeout(() => setToast(""), 4000);
      }
    } finally {
      setActionLoading(null);
      setShowTrackingModal(false);
      setTrackingInput("");
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F7F7F8] flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-[#E5E5E5] border-t-[#0D0D0D] rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-[#F7F7F8] flex items-center justify-center">
        <p className="text-[#6E6E80] font-bold">{t("notFound")}</p>
      </div>
    );
  }

  const statusColor =
    order.status === "paid" ? "bg-neutral-100 text-neutral-900" :
      order.status === "pending" ? "bg-yellow-100 text-yellow-800" :
        order.status === "fulfilled" ? "bg-blue-100 text-blue-800" :
          order.status === "return_requested" ? "bg-orange-100 text-orange-800" :
            order.status === "refunded" ? "bg-purple-100 text-purple-800" :
              order.status === "cancelled" ? "bg-red-100 text-red-800" :
                "bg-gray-100 text-gray-800";

  const fulfillColor =
    order.fulfillmentStatus === "shipped" ? "bg-purple-100 text-purple-800" :
      order.fulfillmentStatus === "processing" ? "bg-yellow-100 text-yellow-800" :
        order.fulfillmentStatus === "manual_required" ? "bg-orange-100 text-orange-800" :
          order.fulfillmentStatus === "failed" ? "bg-red-100 text-red-800" :
            "bg-gray-100 text-gray-800";

  return (
    <div className="min-h-screen bg-[#F7F7F8] p-8">
      <div className="max-w-4xl mx-auto">

        {/* Top Header */}
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <Link href="/admin/orders" className="text-sm font-bold text-[#6E6E80] hover:text-[#0D0D0D] mb-2 inline-block">
              {t("backToOrders")}
            </Link>
            <h1 className="text-2xl font-black text-[#0D0D0D] flex items-center gap-3 flex-wrap">
              {t("orderNumber", { id: orderId.split("-")[0] })}
              <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold ${statusColor}`}>
                {order.statusLabel || order.status.toUpperCase()}
              </span>
              <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold ${fulfillColor}`}>
                {order.fulfillmentStatus || t("fulfillmentPending")}
              </span>
            </h1>
            {order.statusDetail && (
              <p className="text-sm text-[#6E6E80] mt-1">{order.statusDetail}</p>
            )}
            <p className="text-sm text-[#6E6E80] mt-1">
              {t("placedOn", { date: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(order.createdAt)) })}
            </p>
          </div>

          <div className="flex gap-2 flex-wrap">
            {order.status === "paid" && (
              <>
                <button
                  onClick={() => doAction("fulfill")}
                  disabled={!!actionLoading}
                  className="rounded-lg bg-[#0D0D0D] px-4 py-2 text-sm font-bold text-white hover:bg-[#0E906F] disabled:opacity-50 transition"
                >
                  {actionLoading === "fulfill" ? t("processingBtn") : <span className="inline-flex items-center gap-1.5"><Rocket size={14} /> {t("fulfillBtn")}</span>}
                </button>
                <button
                  onClick={() => setShowTrackingModal(true)}
                  disabled={!!actionLoading}
                  className="rounded-lg bg-[#0D0D0D] px-4 py-2 text-sm font-bold text-white hover:bg-[#333] disabled:opacity-50 transition"
                >
                  <span className="inline-flex items-center gap-1.5"><Package size={14} /> {t("addAwbBtn")}</span>
                </button>
              </>
            )}
            {order.status === "fulfilled" && !order.trackingNumber && (
              <button
                onClick={() => setShowTrackingModal(true)}
                disabled={!!actionLoading}
                className="rounded-lg bg-[#0D0D0D] px-4 py-2 text-sm font-bold text-white hover:bg-[#333] disabled:opacity-50 transition"
              >
                <span className="inline-flex items-center gap-1.5"><Package size={14} /> {t("addAwbBtn")}</span>
              </button>
            )}
            {order.status !== "cancelled" && (
              <button
                onClick={async () => {
                  const ok = await confirm({ title: t("cancelConfirm"), confirmLabel: t("cancelBtn"), tone: "danger" });
                  if (ok) doAction("cancel");
                }}
                disabled={!!actionLoading}
                className="rounded-lg bg-white border border-[#E5E5E5] px-4 py-2 text-sm font-bold text-[#df1b41] hover:bg-red-50 disabled:opacity-50 transition"
              >
                {actionLoading === "cancel" ? t("cancelling") : t("cancelBtn")}
              </button>
            )}
            <Link
              href={`/orders/${orderId}`}
              target="_blank"
              className="rounded-lg bg-white border border-[#E5E5E5] px-4 py-2 text-sm font-bold text-[#6E6E80] hover:bg-[#F7F7F8] transition"
            >
              <span className="inline-flex items-center gap-1.5"><Eye size={14} /> {t("clientPage")}</span>
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

          {/* Main Column */}
          <div className="md:col-span-2 space-y-6">

            {/* Items */}
            <div className="bg-white rounded-2xl border border-[#E5E5E5] p-6 shadow-sm">
              <h2 className="text-lg font-black mb-4">{t("itemsTitle")}</h2>
              <div className="space-y-4">
                {items.map((item, i) => (
                  <div key={`${item.title}-${i}`} className="flex gap-4 items-center pb-4 border-b border-[#E5E5E5] last:border-0 last:pb-0">
                    <div className="h-16 w-16 bg-[#F7F7F8] rounded-xl flex items-center justify-center font-bold text-2xl">
                      <Package size={24} className="text-[#6E6E80]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm text-[#0D0D0D] break-words">{item.title}</p>
                      <p className="text-xs text-[#6E6E80]">{t("quantityLabel", { qty: item.quantity })}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-black text-sm">{new Intl.NumberFormat(locale, { style: "currency", currency: "RON" }).format(Number(item.unit_price))}</p>
                      <p className="text-xs text-[#6E6E80]">x {item.quantity}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Payment Info */}
            <div className="bg-white rounded-2xl border border-[#E5E5E5] p-6 shadow-sm">
              <h2 className="text-lg font-black mb-4">{t("paymentSummary")}</h2>
              <div className="space-y-2">
                <div className="flex justify-between text-base font-black pt-2">
                  <span>{t("totalPaid")}</span>
                  <span>{new Intl.NumberFormat(locale, { style: "currency", currency: "RON" }).format(Number(order.totalRon))}</span>
                </div>
              </div>
            </div>

            {/* Tracking Info */}
            {order.trackingNumber && (
              <div className="bg-white rounded-2xl border border-[#0D0D0D]/30 p-6 shadow-sm">
                <h2 className="text-lg font-black mb-3 text-[#0D0D0D] flex items-center gap-2"><Truck size={20} /> {t("trackingCode")}</h2>
                <div className="bg-[#F0FDF4] rounded-xl p-4 flex items-center justify-between">
                  <div>
                    <p className="text-xl font-black font-mono text-[#0D0D0D]">{order.trackingNumber}</p>
                    {order.trackingUrl && (
                      <a href={order.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-[#0D0D0D] font-bold hover:underline">
                        {t("trackPackage")}
                      </a>
                    )}
                  </div>
                </div>
              </div>
            )}

          </div>

          {/* Right Column */}
          <div className="space-y-6">

            {/* Customer Info */}
            <div className="bg-white rounded-2xl border border-[#E5E5E5] p-6 shadow-sm">
              <h2 className="text-base font-black mb-4">{t("customerTitle")}</h2>
              <div className="space-y-1 text-sm">
                <p className="font-bold text-[#0D0D0D]">{order.shipping?.name || t("notSpecified")}</p>
                <p className="text-[#6E6E80]">{order.shipping?.phone || t("noPhone")}</p>
              </div>
            </div>

            {/* Shipping Address */}
            <div className="bg-white rounded-2xl border border-[#E5E5E5] p-6 shadow-sm">
              <h2 className="text-base font-black mb-4">{t("deliveryAddress")}</h2>
              <div className="text-sm text-[#0D0D0D]">
                {order.shipping?.line1 ? (
                  <>
                    <p>{order.shipping.name}</p>
                    <p>{order.shipping.line1}</p>
                    {order.shipping.line2 && <p>{order.shipping.line2}</p>}
                    <p>{order.shipping.city}, {order.shipping.state}</p>
                    <p>{order.shipping.postal_code}, {order.shipping.country}</p>
                  </>
                ) : (
                  <p className="text-[#6E6E80]">{t("noDeliveryAddress")}</p>
                )}
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* Tracking Modal */}
      {showTrackingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowTrackingModal(false)}>
          <div className="bg-white rounded-2xl p-6 max-w-md w-full max-h-[90dvh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-black text-[#0D0D0D] mb-2">{t("addAwbTitle")}</h3>
            <p className="text-sm text-[#6E6E80] mb-4">{t("addAwbDesc")}</p>
            <label htmlFor="tracking-number-input" className="sr-only">{t("addAwbTitle")}</label>
            <input
              id="tracking-number-input"
              type="text"
              value={trackingInput}
              onChange={e => setTrackingInput(e.target.value)}
              placeholder={t("trackingPlaceholder")}
              className="w-full rounded-lg border border-[#E5E5E5] px-4 py-3 text-sm focus:border-[#0D0D0D] focus:outline-none focus:ring-1 focus:ring-[#0D0D0D]"
              autoFocus
            />
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => doAction("add_tracking", { trackingNumber: trackingInput })}
                disabled={!trackingInput.trim() || !!actionLoading}
                className="flex-1 rounded-lg bg-[#0D0D0D] py-3 text-sm font-bold text-white disabled:opacity-50"
              >
                {actionLoading === "add_tracking" ? t("saving") : t("saveAwb")}
              </button>
              <button
                onClick={() => setShowTrackingModal(false)}
                className="rounded-lg bg-[#F7F7F8] px-4 py-3 text-sm font-bold text-[#6E6E80]"
              >
                {t("cancelBtn")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 rounded-full bg-[#0D0D0D] px-6 py-3 text-sm font-bold text-white shadow-xl">
          {toast}
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
