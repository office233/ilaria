"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { FileText, Plus, Search, Printer, X, FileCode, AlertTriangle } from "lucide-react";
import { logger } from "@/lib/logger";
import { RO_COUNTIES } from "@/lib/seller/efactura/counties";
import { openSellerFile } from "@/lib/seller/open-file";

export type InvoiceRow = {
  id: string;
  series: string;
  number: number;
  invoice_number: string;
  client_name: string;
  client_cui: string | null;
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  currency?: string | null;
  status: string;
  efactura_status: string;
  created_at: string;
};

type Props = {
  initialInvoices: InvoiceRow[];
  defaultSeries: string;
  currency: string;
  vatRates: { standard: number; reduced: number };
};

const INVOICE_STATUS_KEYS: Record<string, string> = {
  draft: "statusDraft",
  issued: "statusIssued",
  paid: "statusPaid",
  cancelled: "statusCancelled",
};
const EFACTURA_STATUS_KEYS: Record<string, string> = {
  not_sent: "efacturaNotSent",
  pending: "efacturaPending",
  sent: "efacturaSent",
  accepted: "efacturaAccepted",
  rejected: "efacturaRejected",
};
const API_ERROR_KEYS: Record<string, string> = {
  unauthorized: "errUnauthorized",
  rate_limited: "errRateLimited",
  validation_error: "errValidation",
  invalid_client: "errInvalidClient",
};

const inputCls =
  "w-full px-3 py-2 border border-subtle bg-surface text-fg rounded-control text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand";
const labelCls = "block text-xs font-bold text-fg uppercase tracking-wider mb-1";

export default function InvoicesClient({ initialInvoices, defaultSeries, currency, vatRates }: Props) {
  const t = useTranslations("sellerBilling.invoices");
  const tErr = useTranslations("sellerBilling.efacturaErrors");
  const locale = useLocale();
  const [invoices, setInvoices] = useState<InvoiceRow[]>(initialInvoices);
  const [searchQuery, setSearchQuery] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [efacturaIssues, setEfacturaIssues] = useState<{ number: string; codes: string[] } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [clientName, setClientName] = useState("");
  const [clientCui, setClientCui] = useState("");
  const [clientStreet, setClientStreet] = useState("");
  const [clientCity, setClientCity] = useState("");
  const [clientCounty, setClientCounty] = useState("");
  const [clientPostalCode, setClientPostalCode] = useState("");
  const [clientCountry, setClientCountry] = useState("RO");
  const [series, setSeries] = useState(defaultSeries);
  const [vatRate, setVatRate] = useState<number>(vatRates.standard);
  const [items, setItems] = useState<Array<{ title: string; quantity: number; price: string }>>([
    { title: "", quantity: 1, price: "" },
  ]);

  const addItemRow = () => setItems((prev) => [...prev, { title: "", quantity: 1, price: "" }]);
  const updateItem = (index: number, field: keyof (typeof items)[number], val: string | number) =>
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, [field]: val } : it)));
  const removeItem = (index: number) => setItems((prev) => prev.filter((_, i) => i !== index));

  // Doar previzualizare; totalurile autoritare (cenți întregi) le calculează serverul.
  const totalCents = items.reduce(
    (acc, it) => acc + Math.round((parseFloat(it.price) || 0) * 100) * (it.quantity || 1),
    0,
  );
  const subtotalCents = vatRate > 0 ? Math.round(totalCents / (1 + vatRate / 100)) : totalCents;
  const vatCents = totalCents - subtotalCents;

  const fmtMoney = (cents: number, cur?: string | null) => {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: cur || currency }).format((cents || 0) / 100);
    } catch {
      return `${((cents || 0) / 100).toFixed(2)} ${cur || currency}`;
    }
  };
  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
    } catch {
      return "—";
    }
  };

  const resetForm = () => {
    setClientName("");
    setClientCui("");
    setClientStreet("");
    setClientCity("");
    setClientCounty("");
    setClientPostalCode("");
    setClientCountry("RO");
    setVatRate(vatRates.standard);
    setItems([{ title: "", quantity: 1, price: "" }]);
    setFormError(null);
  };

  const handleCreateInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientName.trim() || items.length === 0) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch("/api/seller/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          clientCui,
          clientStreet,
          clientCity,
          clientCounty,
          clientPostalCode,
          clientCountry,
          series,
          vatRate,
          items,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setFormError(t(API_ERROR_KEYS[data?.error as string] ?? "errUnknown"));
        return;
      }
      setInvoices((prev) => [data.invoice as InvoiceRow, ...prev]);
      setIsModalOpen(false);
      resetForm();
    } catch (err) {
      logger.error({ err }, "[SellerInvoices] create invoice failed");
      setFormError(t("errNetwork"));
    } finally {
      setSubmitting(false);
    }
  };

  const openPdf = async (inv: InvoiceRow) => {
    setPageError(null);
    setBusyId(inv.id);
    const result = await openSellerFile("invoice_pdf", inv.id, `${inv.invoice_number}.pdf`);
    setBusyId(null);
    if (result === "failed") setPageError(t("errFileOpen"));
  };

  /** Validează pe server înainte de export: lipsurile se afișează, nu se inventează date. */
  const openXml = async (inv: InvoiceRow) => {
    setPageError(null);
    setEfacturaIssues(null);
    setBusyId(inv.id);
    try {
      const res = await fetch(`/api/seller/invoices/${inv.id}/efactura?check=1`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setPageError(t(API_ERROR_KEYS[data?.error as string] ?? "errUnknown"));
        return;
      }
      if (!data.valid) {
        setEfacturaIssues({ number: inv.invoice_number, codes: data.errors as string[] });
        return;
      }
      const result = await openSellerFile("invoice_xml", inv.id, `${inv.invoice_number}-eFactura.xml`);
      if (result === "failed") setPageError(t("errFileOpen"));
    } catch {
      setPageError(t("errNetwork"));
    } finally {
      setBusyId(null);
    }
  };

  const q = searchQuery.toLowerCase();
  const filteredInvoices = invoices.filter(
    (inv) =>
      inv.client_name.toLowerCase().includes(q) ||
      inv.invoice_number.toLowerCase().includes(q) ||
      (inv.client_cui && inv.client_cui.toLowerCase().includes(q)),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-3 text-subtle w-4 h-4" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="w-full pl-10 pr-4 py-2.5 bg-surface border border-subtle rounded-control text-sm font-semibold text-fg focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
        <button
          type="button"
          onClick={() => setIsModalOpen(true)}
          className="inline-flex items-center justify-center gap-2 bg-fg text-fg-inverse hover:opacity-90 px-5 py-2.5 min-h-[44px] rounded-control font-bold text-sm shadow-elev-1 transition"
        >
          <Plus size={16} /> {t("newInvoice")}
        </button>
      </div>

      {pageError ? (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
          {pageError}
        </p>
      ) : null}

      {efacturaIssues ? (
        <div role="alert" className="rounded-card border border-warning/40 bg-warning-soft p-4 text-sm text-fg space-y-2">
          <div className="flex items-start justify-between gap-3">
            <p className="flex items-center gap-2 font-bold">
              <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
              {t("efacturaInvalidTitle", { number: efacturaIssues.number })}
            </p>
            <button
              type="button"
              onClick={() => setEfacturaIssues(null)}
              aria-label={t("closeModal")}
              className="hit-target-44 -m-2 text-muted hover:text-fg"
            >
              <X size={16} />
            </button>
          </div>
          <ul className="list-disc pl-5 space-y-1 text-muted">
            {efacturaIssues.codes.map((code) => (
              <li key={code}>{tErr.has(code) ? tErr(code) : code}</li>
            ))}
          </ul>
          <Link href="/seller/settings" className="inline-flex min-h-[44px] items-center font-bold text-brand">
            {t("efacturaFixSettings")}
          </Link>
        </div>
      ) : null}

      <div className="bg-surface border border-subtle rounded-card shadow-elev-1 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-2 border-b border-subtle text-xs font-bold text-muted uppercase tracking-wider">
              <tr>
                <th className="px-6 py-4">{t("thSeriesNumber")}</th>
                <th className="px-6 py-4">{t("thClient")}</th>
                <th className="px-6 py-4">{t("thIssueDate")}</th>
                <th className="px-6 py-4">{t("thTotal")}</th>
                <th className="px-6 py-4">{t("thStatus")}</th>
                <th className="px-6 py-4">{t("thEfactura")}</th>
                <th className="px-6 py-4 text-right">{t("thActions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-subtle">
              {filteredInvoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-surface-2 transition">
                  <td className="px-6 py-4 font-black text-brand font-mono whitespace-nowrap">{inv.invoice_number}</td>
                  <td className="px-6 py-4 max-w-[220px]">
                    <div className="font-bold text-fg break-words">{inv.client_name}</div>
                    {inv.client_cui && (
                      <div className="text-xs text-subtle font-mono break-words">
                        {t("cui")}: {inv.client_cui}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-muted text-xs font-medium whitespace-nowrap">{fmtDate(inv.created_at)}</td>
                  <td className="px-6 py-4 font-black text-fg whitespace-nowrap">{fmtMoney(inv.total_cents, inv.currency)}</td>
                  <td className="px-6 py-4">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold bg-surface-2 text-fg border border-subtle whitespace-nowrap">
                      {t(INVOICE_STATUS_KEYS[inv.status] ?? "statusIssued")}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-surface-2 text-muted border border-subtle whitespace-nowrap">
                      {t(EFACTURA_STATUS_KEYS[inv.efactura_status] ?? "efacturaNotSent")}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => openXml(inv)}
                        disabled={busyId === inv.id}
                        className="px-2.5 py-1.5 min-h-[44px] rounded-control border border-brand/30 bg-brand-soft text-brand-soft-fg hover:opacity-90 transition text-xs font-bold flex items-center gap-1 disabled:opacity-50"
                        title={t("downloadXmlTitle")}
                        aria-label={t("downloadXmlTitle")}
                      >
                        <FileCode size={13} /> {t("downloadXml")}
                      </button>
                      <button
                        type="button"
                        onClick={() => openPdf(inv)}
                        disabled={busyId === inv.id}
                        className="hit-target-44 text-muted hover:text-fg rounded-control hover:bg-surface-2 transition disabled:opacity-50"
                        title={t("printTitle")}
                        aria-label={t("printTitle")}
                      >
                        <Printer size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredInvoices.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-16 text-center text-subtle text-sm">
                    {t("emptyState")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-overlay flex items-center justify-center p-4 bg-overlay/60 backdrop-blur-sm">
          <div className="bg-surface text-fg rounded-sheet p-6 max-w-2xl w-full shadow-elev-3 space-y-5 max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-subtle pb-4">
              <div className="flex items-center gap-2 text-lg font-black text-fg">
                <FileText className="w-5 h-5 text-brand" />
                {t("modalTitle")}
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="hit-target-44 rounded-control text-subtle hover:text-fg"
                aria-label={t("closeModal")}
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleCreateInvoice} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className={labelCls}>{t("clientNameLabel")}</label>
                  <input type="text" required value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder={t("clientNamePlaceholder")} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>{t("seriesLabel")}</label>
                  <input type="text" value={series} onChange={(e) => setSeries(e.target.value)} className={`${inputCls} uppercase`} />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className={labelCls}>{t("cuiLabel")}</label>
                  <input type="text" value={clientCui} onChange={(e) => setClientCui(e.target.value)} placeholder={t("cuiPlaceholder")} className={inputCls} />
                </div>
                <div className="sm:col-span-2">
                  <label className={labelCls}>{t("streetLabel")}</label>
                  <input type="text" value={clientStreet} onChange={(e) => setClientStreet(e.target.value)} placeholder={t("streetPlaceholder")} className={inputCls} />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className={labelCls}>{t("cityLabel")}</label>
                  <input type="text" value={clientCity} onChange={(e) => setClientCity(e.target.value)} placeholder={t("cityPlaceholder")} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>{t("countyLabel")}</label>
                  <select value={clientCounty} onChange={(e) => setClientCounty(e.target.value)} className={inputCls} disabled={clientCountry !== "RO"}>
                    <option value="">{t("countyPlaceholder")}</option>
                    {RO_COUNTIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>{t("postalCodeLabel")}</label>
                  <input type="text" value={clientPostalCode} onChange={(e) => setClientPostalCode(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>{t("countryLabel")}</label>
                  <input
                    type="text"
                    maxLength={2}
                    value={clientCountry}
                    onChange={(e) => setClientCountry(e.target.value.toUpperCase())}
                    className={`${inputCls} uppercase`}
                  />
                </div>
              </div>
              <p className="text-xs text-muted">{t("addressHint")}</p>

              <div>
                <label className={labelCls}>{t("vatRateLabel")}</label>
                <select value={vatRate} onChange={(e) => setVatRate(Number(e.target.value))} className={inputCls}>
                  <option value={vatRates.standard}>{t("vatStandard", { rate: vatRates.standard })}</option>
                  <option value={vatRates.reduced}>{t("vatReduced", { rate: vatRates.reduced })}</option>
                  <option value={0}>{t("vatExempt")}</option>
                </select>
              </div>

              <div className="pt-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-fg uppercase tracking-wider">{t("itemsLabel")}</span>
                  <button type="button" onClick={addItemRow} className="text-xs font-bold text-brand min-h-[44px] px-2">
                    {t("addLine")}
                  </button>
                </div>
                <div className="space-y-2">
                  {items.map((it, idx) => (
                    <div key={idx} className="flex gap-2 items-center">
                      <input
                        type="text"
                        required
                        value={it.title}
                        onChange={(e) => updateItem(idx, "title", e.target.value)}
                        placeholder={t("itemTitlePlaceholder")}
                        className="flex-1 min-w-0 px-3 py-2 border border-subtle bg-surface rounded-control text-xs font-medium"
                      />
                      <input
                        type="number"
                        min="1"
                        value={it.quantity}
                        onChange={(e) => updateItem(idx, "quantity", parseInt(e.target.value) || 1)}
                        placeholder={t("itemQtyPlaceholder")}
                        aria-label={t("itemQtyPlaceholder")}
                        className="w-16 shrink-0 px-2 py-2 border border-subtle bg-surface rounded-control text-xs font-medium text-center"
                      />
                      <input
                        type="number"
                        step="0.01"
                        required
                        value={it.price}
                        onChange={(e) => updateItem(idx, "price", e.target.value)}
                        placeholder={t("itemPricePlaceholder")}
                        aria-label={t("itemPricePlaceholder")}
                        className="w-24 shrink-0 px-2 py-2 border border-subtle bg-surface rounded-control text-xs font-medium text-right"
                      />
                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          className="hit-target-44 text-subtle hover:text-danger shrink-0"
                          aria-label={t("removeLine")}
                        >
                          <X size={16} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-surface-2 p-4 rounded-control text-xs space-y-1 text-muted">
                <div className="flex justify-between">
                  <span>{t("subtotalNoVat")}</span>
                  <span className="font-semibold">{fmtMoney(subtotalCents)}</span>
                </div>
                <div className="flex justify-between">
                  <span>{t("vatLabel", { rate: vatRate })}</span>
                  <span className="font-semibold">{fmtMoney(vatCents)}</span>
                </div>
                <div className="flex justify-between text-sm font-black text-fg pt-1 border-t border-subtle">
                  <span>{t("totalInvoice")}</span>
                  <span className="text-brand">{fmtMoney(totalCents)}</span>
                </div>
              </div>

              {formError ? (
                <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
                  {formError}
                </p>
              ) : null}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2.5 min-h-[44px] rounded-control border border-subtle text-xs font-bold hover:bg-surface-2">
                  {t("cancel")}
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-6 py-2.5 min-h-[44px] rounded-control bg-brand hover:bg-brand-hover text-brand-fg text-xs font-bold shadow-elev-1 disabled:opacity-50"
                >
                  {submitting ? t("submitting") : t("submit")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
