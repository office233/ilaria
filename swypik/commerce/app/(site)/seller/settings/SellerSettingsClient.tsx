"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";
import { ProductImagesField } from "@/components/seller/products/ProductImagesField";
import { RO_COUNTIES } from "@/lib/seller/efactura/counties";
import { Store, ExternalLink, Save, CheckCircle2, AlertCircle, Building, Sparkles } from "lucide-react";

export type SellerSettingsInitialData = {
  sellerId: string;
  name: string;
  username: string;
  email: string;
  bio: string;
  avatarUrl: string;
  cui: string;
  phone: string;
  iban: string;
  invoiceSeries: string;
  legalName: string;
  tradeRegister: string;
  street: string;
  city: string;
  county: string;
  postalCode: string;
  country: string;
  vatExemptionReason: string;
};

type Props = { initialData: SellerSettingsInitialData; commissionPct: string; publicHost: string };

const ERROR_KEYS: Record<string, string> = {
  unauthorized: "errorUnauthorized",
  rate_limited: "errorRateLimited",
  validation_error: "errorValidation",
  handle_too_short: "errorHandleTooShort",
  handle_taken: "errorHandleTaken",
  seller_not_found: "errorSellerNotFound",
  invalid_cui: "errorInvalidCui",
};

const inputCls =
  "w-full px-3.5 py-2.5 border border-subtle bg-surface text-fg rounded-control text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand";
const labelCls = "block text-xs font-bold text-fg uppercase tracking-wider mb-1.5";

export default function SellerSettingsClient({ initialData, commissionPct, publicHost }: Props) {
  const t = useTranslations("sellerGrowthSettings");
  const [form, setForm] = useState(initialData);
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const set = <K extends keyof SellerSettingsInitialData>(key: K, value: SellerSettingsInitialData[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));
  const cleanHandle = form.username.toLowerCase().replace(/[^a-z0-9_-]/g, "");

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSuccessMsg(null);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/seller/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, sellerId: undefined, email: undefined, username: cleanHandle }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMsg(t(ERROR_KEYS[data?.error as string] ?? "errorSave"));
        return;
      }
      setSuccessMsg(t("saveSuccess"));
      set("username", data.username);
    } catch (err) {
      logger.error({ err }, "Failed to save seller settings");
      setErrorMsg(t("errorSave"));
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof SellerSettingsInitialData, label: string, opts: { placeholder?: string; type?: string; required?: boolean; upper?: boolean } = {}) => (
    <div>
      <label className={labelCls} htmlFor={`seller-${key}`}>
        {label}
      </label>
      <input
        id={`seller-${key}`}
        type={opts.type ?? "text"}
        required={opts.required}
        value={form[key]}
        onChange={(e) => set(key, e.target.value)}
        placeholder={opts.placeholder}
        className={`${inputCls}${opts.upper ? " uppercase" : ""}`}
      />
    </div>
  );

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-subtle pb-5">
        <div>
          <h1 className="text-2xl font-black text-fg">{t("title")}</h1>
          <p className="text-sm text-muted mt-1">{t("subtitle")}</p>
        </div>
        {cleanHandle && (
          <Link
            href={`/u/${cleanHandle}`}
            target="_blank"
            className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-control bg-brand hover:bg-brand-hover text-brand-fg text-sm font-bold shadow-elev-1 transition"
          >
            <ExternalLink size={16} /> {t("viewStore")}
          </Link>
        )}
      </div>

      {successMsg && (
        <div role="status" className="p-4 rounded-control bg-success-soft border border-success/30 text-success flex items-center gap-3 text-sm font-medium">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          {successMsg}
        </div>
      )}
      {errorMsg && (
        <div role="alert" className="p-4 rounded-control bg-danger-soft border border-danger/30 text-danger flex items-center gap-3 text-sm font-medium">
          <AlertCircle className="w-5 h-5 shrink-0" />
          {errorMsg}
        </div>
      )}

      <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-6">
          <div className="bg-surface border border-subtle rounded-card p-6 shadow-elev-1 space-y-5">
            <div className="flex items-center gap-2 text-lg font-bold text-fg">
              <Store className="w-5 h-5 text-brand" />
              {t("publicProfileTitle")}
            </div>
            <p className="text-xs text-muted">{t("publicProfileHint")}</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {field("name", t("storeNameLabel"), { placeholder: t("storeNamePlaceholder"), required: true })}
              <div>
                <label className={labelCls} htmlFor="seller-username">
                  {t("handleLabel")}
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-2.5 text-subtle font-bold text-sm">@</span>
                  <input
                    id="seller-username"
                    type="text"
                    required
                    value={form.username}
                    onChange={(e) => set("username", e.target.value)}
                    className={`${inputCls} pl-8`}
                  />
                </div>
                <p className="text-xs text-subtle mt-1 break-all">
                  {t("yourLink")}: <span className="text-brand font-semibold">{publicHost}/u/{cleanHandle || "…"}</span>
                </p>
              </div>
            </div>

            <div>
              <p className={labelCls}>{t("logoLabel")}</p>
              <ProductImagesField
                images={form.avatarUrl ? [form.avatarUrl] : []}
                max={1}
                onChange={(images) => set("avatarUrl", images[0] ?? "")}
              />
            </div>

            <div>
              <label className={labelCls} htmlFor="seller-bio">
                {t("bioLabel")}
              </label>
              <textarea
                id="seller-bio"
                rows={3}
                value={form.bio}
                onChange={(e) => set("bio", e.target.value)}
                placeholder={t("bioPlaceholder")}
                className={`${inputCls} font-medium resize-none`}
              />
            </div>
          </div>

          <div className="bg-surface border border-subtle rounded-card p-6 shadow-elev-1 space-y-5">
            <div className="flex items-center gap-2 text-lg font-bold text-fg">
              <Building className="w-5 h-5 text-brand" />
              {t("fiscalTitle")}
            </div>
            <p className="text-xs text-muted">{t("fiscalHint")}</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {field("legalName", t("legalNameLabel"), { placeholder: t("legalNamePlaceholder") })}
              {field("cui", t("cuiLabel"), { placeholder: t("cuiPlaceholder"), upper: true })}
              {field("tradeRegister", t("tradeRegisterLabel"), { placeholder: t("tradeRegisterPlaceholder"), upper: true })}
              {field("phone", t("phoneLabel"), { type: "tel" })}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">{field("street", t("streetLabel"), { placeholder: t("streetPlaceholder") })}</div>
              {field("city", t("cityLabel"), { placeholder: t("cityPlaceholder") })}
              <div>
                <label className={labelCls} htmlFor="seller-county">
                  {t("countyLabel")}
                </label>
                <select
                  id="seller-county"
                  value={form.county}
                  onChange={(e) => set("county", e.target.value)}
                  className={inputCls}
                  disabled={form.country.toUpperCase() !== "RO"}
                >
                  <option value="">{t("countyPlaceholder")}</option>
                  {RO_COUNTIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              {field("postalCode", t("postalCodeLabel"))}
              {field("country", t("countryLabel"), { upper: true })}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {field("iban", t("ibanLabel"), { upper: true })}
              <div>
                {field("invoiceSeries", t("invoiceSeriesLabel"), { upper: true })}
                <p className="text-xs text-subtle mt-1">{t("invoiceSeriesHint")}</p>
              </div>
              <div className="sm:col-span-2">
                {field("vatExemptionReason", t("vatExemptionReasonLabel"))}
                <p className="text-xs text-subtle mt-1">{t("vatExemptionReasonHint")}</p>
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 bg-fg text-fg-inverse hover:opacity-90 px-6 py-3 min-h-[44px] rounded-control text-sm font-bold shadow-elev-1 transition disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {saving ? t("saving") : t("saveSettings")}
            </button>
          </div>
        </div>

        <div className="space-y-4">
          <div className="text-xs font-bold text-subtle uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-brand" />
            {t("previewTitle")}
          </div>
          <div className="bg-surface border border-subtle rounded-card p-5 shadow-elev-1 space-y-4 text-center">
            <div className="mx-auto w-20 h-20 rounded-full bg-brand-soft border-2 border-brand flex items-center justify-center overflow-hidden">
              {form.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={form.avatarUrl} alt={t("logoAlt")} width={80} height={80} className="w-full h-full object-cover" />
              ) : (
                <Store className="w-8 h-8 text-brand" />
              )}
            </div>
            <div>
              <h3 className="font-black text-lg text-fg break-words">{form.name || t("storeNameFallback")}</h3>
              <p className="text-xs font-bold text-brand break-all">@{cleanHandle || "…"}</p>
            </div>
            <p className="text-xs text-muted line-clamp-3 italic">&ldquo;{form.bio || t("bioFallback")}&rdquo;</p>
            <div className="pt-3 border-t border-subtle grid grid-cols-2 gap-2 text-xs">
              <div className="bg-surface-2 p-2 rounded-control font-medium text-muted">
                <span className="block font-bold text-fg">{t("socialFeed")}</span> {t("active")}
              </div>
              <div className="bg-surface-2 p-2 rounded-control font-medium text-muted">
                <span className="block font-bold text-fg">{t("commission")}</span> {commissionPct}
              </div>
            </div>
            <div className="text-xs text-subtle break-all">
              {t("publicPage")}
              <br />
              <strong className="text-fg">
                {publicHost}/u/{cleanHandle || "…"}
              </strong>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
