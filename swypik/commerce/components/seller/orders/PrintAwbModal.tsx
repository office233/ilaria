"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { X, Printer, Loader2 } from "lucide-react";
import type { SellerOrderRow as SellerOrder } from "./types";
import type { AwbLabel } from "@/lib/seller/awb-label";
import { openSellerFile } from "@/lib/seller/open-file";
import { Code128Barcode } from "./Code128Barcode";

type Props = {
  order: SellerOrder | null;
  isOpen: boolean;
  onClose: () => void;
};

const KNOWN_ERROR_CODES = new Set(["unauthorized", "not_found", "rate_limited", "server_error", "feature_frozen"]);

/**
 * Previzualizarea etichetei de expediere. Tipărirea/salvarea merge prin PDF-ul
 * generat pe server (funcționează și în aplicația mobilă, unde `window.print()`
 * nu face nimic). Codul de bare e Code 128 real: AWB-ul curierului sau, dacă
 * lipsește, un cod intern al comenzii marcat clar ca atare.
 */
export default function PrintAwbModal({ order, isOpen, onClose }: Props) {
  const t = useTranslations("sellerOrders");
  const locale = useLocale();
  const [data, setData] = useState<AwbLabel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    // Gardă anti-stale: un răspuns întârziat pentru altă comandă nu se aplică.
    let cancelled = false;
    if (isOpen && order) {
      setLoading(true);
      setError(null);
      fetch(`/api/seller/orders/${order.order_id}/awb`)
        .then((res) => res.json().catch(() => ({})).then((json) => ({ res, json })))
        .then(({ res, json }) => {
          if (cancelled) return;
          if (res.ok && json.success) setData(json as AwbLabel);
          else setError(t(KNOWN_ERROR_CODES.has(json.error) ? `errors.${json.error}` : "errors.server_error"));
        })
        .catch(() => {
          if (!cancelled) setError(t("printModal.connectionError"));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    } else {
      setData(null);
    }
    return () => {
      cancelled = true;
    };
  }, [isOpen, order, t]);

  const money = useMemo(() => {
    const currency = data?.order.currency || "RON";
    try {
      const f = new Intl.NumberFormat(locale, { style: "currency", currency });
      return (cents: number) => f.format(cents / 100);
    } catch {
      return (cents: number) => `${(cents / 100).toFixed(2)} ${currency}`;
    }
  }, [data?.order.currency, locale]);

  if (!isOpen || !order) return null;

  const carrierAwb = data?.awb.trackingNumber?.trim() || null;
  const barcodeValue = carrierAwb || data?.order.orderNumber || order.order_id.slice(0, 8).toUpperCase();
  const carrierName = data?.awb.carrierName || t("printModal.noCarrier");

  const openPdf = async () => {
    setOpening(true);
    setError(null);
    const result = await openSellerFile("awb_label", order.order_id, `AWB-${data?.order.orderNumber ?? order.order_id}.pdf`);
    setOpening(false);
    if (result === "failed") setError(t("printModal.fileError"));
  };

  return (
    <div className="fixed inset-0 z-overlay flex items-center justify-center p-3 md:p-6 bg-overlay/60 backdrop-blur-sm overflow-y-auto">
      <div className="bg-surface text-fg w-full max-w-2xl rounded-card shadow-elev-3 border border-subtle overflow-hidden my-6 flex flex-col max-h-[90dvh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-subtle bg-surface-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-brand-soft text-brand-soft-fg shrink-0">
              {carrierName}
            </span>
            <h2 className="text-base font-bold text-fg truncate">
              {t("printModal.labelTitle", { awb: carrierAwb || t("printModal.awbPending") })}
            </h2>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={openPdf}
              disabled={!data || opening}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] text-xs font-bold bg-fg text-fg-inverse hover:opacity-90 rounded-control shadow-elev-1 transition disabled:opacity-50"
            >
              {opening ? <Loader2 size={15} className="animate-spin" /> : <Printer size={15} />}
              {t("actions.printAwb")}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("actions.close")}
              className="hit-target-44 rounded-control text-subtle hover:text-fg hover:bg-surface transition"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-4 md:p-6 flex justify-center bg-canvas">
          {loading ? (
            <div className="py-20 flex flex-col items-center justify-center text-muted gap-3">
              <Loader2 size={32} className="animate-spin text-brand" />
              <p className="text-xs font-semibold">{t("printModal.loading")}</p>
            </div>
          ) : error && !data ? (
            <div className="py-12 text-center text-danger">
              <p className="text-sm font-bold">{error}</p>
              <button type="button" onClick={onClose} className="mt-4 px-4 py-2 min-h-[44px] text-xs font-semibold bg-surface-2 rounded-control text-fg">
                {t("actions.close")}
              </button>
            </div>
          ) : data ? (
            <div className="bg-surface text-fg w-full max-w-[620px] p-6 rounded-control border-2 border-strong shadow-elev-1 text-xs space-y-4">
              {error ? <p className="text-xs text-danger">{error}</p> : null}
              <div className="border-2 border-strong rounded-control p-3 flex flex-col items-center">
                <p className="text-xs uppercase font-bold text-muted tracking-wider mb-1">
                  {carrierAwb ? t("printModal.barcodeLabel") : t("printModal.internalBarcode")}
                </p>
                <Code128Barcode value={barcodeValue} label={t("printModal.barcodeLabel")} />
                <p className="text-xs text-muted mt-1">{t("printModal.orderNumber", { id: data.order.orderNumber })}</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="border border-strong p-3 rounded-control">
                  <div className="border-b border-subtle pb-1 mb-2 font-black uppercase text-xs tracking-wider text-muted">
                    {t("printModal.senderTitle")}
                  </div>
                  <p className="font-bold text-fg text-xs">{data.sender.name || "—"}</p>
                  {data.sender.cui && <p className="text-xs text-muted">{t("printModal.cui", { cui: data.sender.cui })}</p>}
                  <p className="text-xs text-fg mt-1">{[data.sender.address, data.sender.city, data.sender.county].filter(Boolean).join(", ") || "—"}</p>
                  {data.sender.phone && <p className="text-xs text-muted mt-1">{t("printModal.phone", { phone: data.sender.phone })}</p>}
                </div>
                <div className="border-2 border-strong p-3 rounded-control">
                  <div className="border-b border-subtle pb-1 mb-2 font-black uppercase text-xs tracking-wider text-fg">
                    {t("printModal.recipientTitle")}
                  </div>
                  <p className="font-black text-fg text-sm">{data.recipient.name || "—"}</p>
                  {data.recipient.phone && <p className="text-xs font-black text-fg mt-0.5">{t("printModal.phone", { phone: data.recipient.phone })}</p>}
                  <p className="text-xs text-fg mt-1 font-medium">{data.recipient.line1 || "—"}</p>
                  {data.recipient.line2 && <p className="text-xs text-fg">{data.recipient.line2}</p>}
                  <p className="text-xs font-bold text-fg">
                    {[data.recipient.postalCode, data.recipient.city, data.recipient.county].filter(Boolean).join(", ")}
                  </p>
                  {data.recipient.lockerName && (
                    <div className="mt-2 p-1.5 bg-brand-soft border border-brand/30 rounded text-brand-soft-fg font-bold text-xs">
                      {t("detailsModal.locker", { locker: data.recipient.lockerName })}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 border border-strong rounded-control p-2 text-xs">
                <div>
                  <p className="font-bold text-muted">{t("printModal.colParcels")}</p>
                  <p className="font-bold">{t("printModal.parcelCount", { count: data.awb.parcelsCount })}</p>
                </div>
                <div>
                  <p className="font-bold text-muted">{t("printModal.colWeight")}</p>
                  <p className="font-bold">{data.awb.weightKg != null ? t("printModal.weightValue", { kg: data.awb.weightKg }) : "—"}</p>
                </div>
                <div>
                  <p className="font-bold text-muted">{t("printModal.colInsuredValue")}</p>
                  <p className="font-bold">{money(data.order.totalCents)}</p>
                </div>
              </div>

              <div className="border border-subtle rounded-control p-2.5 bg-surface-2">
                <p className="text-xs uppercase font-bold text-muted mb-1">{t("printModal.contentsLabel")}</p>
                <div className="space-y-1">
                  {data.order.items.map((item) => (
                    <div key={item.id} className="flex justify-between text-xs">
                      <span className="font-medium text-fg">
                        {item.quantity}x {item.title}
                      </span>
                      <span className="font-mono text-muted font-semibold">{money(item.quantity * item.unitCents)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {data.awb.notes ? (
                <p className="text-xs text-muted italic">
                  {t("printModal.instructionsLabel")} {data.awb.notes}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
